import http from "node:http";
import { randomUUID } from "node:crypto";
import { CopilotClient } from "@github/copilot-sdk";
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { WebSocket, WebSocketServer } from "ws";

const requiredEnv = ["AWS_REGION", "SQS_QUEUE_URL", "JOBS_BUCKET", "COPILOT_GITHUB_TOKEN"];
for (const key of requiredEnv) {
  if (!process.env[key]) throw new Error(`${key} is required`);
}

const port = Number(process.env.PORT ?? 8080);
const maxPromptBytes = Number(process.env.MAX_PROMPT_BYTES ?? 200 * 1024);
const maxOutputBytes = Number(process.env.MAX_OUTPUT_BYTES ?? 25 * 1024 * 1024);
const maxJobDurationMs = Number(process.env.MAX_JOB_DURATION_MS ?? 60 * 60 * 1000);
const allowedModels = new Set((process.env.ALLOWED_MODELS ?? "gpt-5.4,gpt-6-luna,claude-haiku-5.5,MAI-Code-1.1-Flash").split(",").map((model) => model.trim()).filter(Boolean));
const region = process.env.AWS_REGION;
const queueUrl = process.env.SQS_QUEUE_URL;
const bucket = process.env.JOBS_BUCKET;
const corsHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "Accept, Content-Type",
  "access-control-max-age": "86400",
};

const s3 = new S3Client({ region });
const sqs = new SQSClient({ region });
const copilot = new CopilotClient({
  gitHubToken: process.env.COPILOT_GITHUB_TOKEN,
  mode: "empty",
  useLoggedInUser: false,
  sessionIdleTimeoutSeconds: 30 * 60,
  baseDirectory: "/tmp/copilot-home",
  logLevel: "error",
});

const server = http.createServer(async (request, response) => {
  for (const [name, value] of Object.entries(corsHeaders)) response.setHeader(name, value);
  if (request.method === "OPTIONS") {
    response.writeHead(204).end();
    return;
  }

  try {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (request.method === "GET" && url.pathname === "/health") {
      return sendJson(response, 200, { status: "ok" });
    }
    if (request.method === "GET" && url.pathname === "/v1/models") {
      return sendJson(response, 200, {
        object: "list",
        data: [...allowedModels].map((id) => ({ id, object: "model", owned_by: "github-copilot" })),
      });
    }

    const jobMatch = url.pathname.match(/^\/v1\/jobs\/([^/]+)$/);
    if (request.method === "GET" && jobMatch) {
      const job = await readJob(decodeURIComponent(jobMatch[1]));
      return job ? sendJson(response, 200, job) : sendJson(response, 404, { error: "job_not_found" });
    }

    const resultMatch = url.pathname.match(/^\/v1\/jobs\/([^/]+)\/result$/);
    if (request.method === "GET" && resultMatch) {
      const job = await readJob(decodeURIComponent(resultMatch[1]));
      if (!job) return sendJson(response, 404, { error: "job_not_found" });
      if (!job.resultKey) return sendJson(response, 409, { error: "result_not_ready", status: job.status });
      const result = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: job.resultKey }));
      response.writeHead(200, {
        "content-type": "text/markdown; charset=utf-8",
        "content-length": String(result.ContentLength ?? 0),
      });
      result.Body.pipe(response);
      return;
    }

    return sendJson(response, 404, { error: "not_found" });
  } catch (error) {
    console.error("http_request_failed", error.name ?? "Error");
    if (!response.headersSent) sendJson(response, 500, { error: "internal_error" });
    else response.destroy();
  }
});

const webSockets = new WebSocketServer({ noServer: true, maxPayload: maxPromptBytes + 16 * 1024 });
const watchers = new Map();
const activeJobs = new Map();
let stopping = false;

server.on("upgrade", (request, socket, head) => {
  if (stopping || request.url !== "/v1/ws") {
    socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  webSockets.handleUpgrade(request, socket, head, (webSocket) => webSockets.emit("connection", webSocket, request));
});

webSockets.on("connection", (webSocket) => {
  webSocket.on("message", async (raw) => {
    if (stopping) {
      sendSocket(webSocket, { type: "shutdown", reason: "deploy", graceSeconds: 0 });
      return;
    }
    let message;
    try {
      message = JSON.parse(raw.toString());
      if (!message || typeof message !== "object" || typeof message.action !== "string") throw new Error("invalid_message");
      if (message.action === "startGeneration") {
        await enqueueJob(message, webSocket);
      } else if (message.action === "watchJob" || message.action === "getJob") {
        const jobId = validateJobId(message.jobId);
        const job = await readJob(jobId);
        if (!job) return sendSocket(webSocket, { type: "failed", error: "job_not_found" });
        addWatcher(jobId, webSocket);
        sendSocket(webSocket, { type: "job", ...job });
      } else if (message.action === "cancelJob") {
        await cancelJob(validateJobId(message.jobId), webSocket);
      } else {
        sendSocket(webSocket, { type: "failed", error: "unknown_action" });
      }
    } catch (error) {
      sendSocket(webSocket, { type: "failed", error: publicError(error) });
    }
  });

  webSocket.on("close", () => {
    for (const sockets of watchers.values()) sockets.delete(webSocket);
  });
});

async function enqueueJob(message, webSocket) {
  const requestId = validateRequestId(message.requestId);
  const model = typeof message.model === "string" ? message.model : "";
  const prompt = typeof message.prompt === "string" ? message.prompt : "";
  if (!allowedModels.has(model)) throw new Error("model_not_allowed");
  if (!prompt.trim()) throw new Error("prompt_required");
  if (Buffer.byteLength(prompt, "utf8") > maxPromptBytes) throw new Error("prompt_too_large");

  const jobId = `job_${randomUUID()}`;
  const now = new Date().toISOString();
  const manifest = { jobId, requestId, model, status: "queued", createdAt: now, updatedAt: now, bytes: 0 };
  const inputKey = `inputs/${jobId}.json`;
  const manifestKey = `jobs/${jobId}.json`;
  const requestKey = `requests/${requestId}.json`;

  await putJson(inputKey, { prompt });
  await putJson(manifestKey, manifest);
  try {
    await putJson(requestKey, { jobId, createdAt: now }, true);
  } catch (error) {
    if (!isConditionalConflict(error)) throw error;
    await Promise.all([
      s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: inputKey })),
      s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: manifestKey })),
    ]);
    const existing = await getJson(requestKey);
    addWatcher(existing.jobId, webSocket);
    sendSocket(webSocket, { type: "accepted", requestId, jobId: existing.jobId, duplicate: true });
    return;
  }

  addWatcher(jobId, webSocket);
  try {
    await sqs.send(new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify({ jobId }),
      MessageGroupId: "generation",
      MessageDeduplicationId: requestId,
    }));
    sendSocket(webSocket, { type: "accepted", requestId, jobId });
  } catch (error) {
    await writeJob({ ...manifest, status: "failed", error: "queue_unavailable", updatedAt: new Date().toISOString() });
    throw error;
  }
}

async function cancelJob(jobId, webSocket) {
  const job = await readJob(jobId);
  if (!job) return sendSocket(webSocket, { type: "failed", error: "job_not_found" });
  if (["completed", "failed", "cancelled", "truncated", "interrupted"].includes(job.status)) {
    return sendSocket(webSocket, { type: "job", ...job });
  }

  await putJson(`cancellations/${jobId}.json`, { requestedAt: new Date().toISOString() });
  const active = activeJobs.get(jobId);
  if (active?.session) await active.session.abort().catch(() => {});
  sendSocket(webSocket, { type: "job", jobId, status: "cancel_requested" });
}

async function pollQueue() {
  while (!stopping) {
    try {
      const result = await sqs.send(new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: 20,
        VisibilityTimeout: 120,
        MessageSystemAttributeNames: ["ApproximateReceiveCount"],
      }));
      const message = result.Messages?.[0];
      if (!message) continue;
      if (stopping) break;
      await processQueueMessage(message);
    } catch (error) {
      if (!stopping) {
        console.error("queue_poll_failed", error.name ?? "Error");
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    }
  }
}

async function processQueueMessage(message) {
  let jobId;
  let stage = "parse_message";
  let generationStarted = false;
  let visibilityTimer;
  try {
    jobId = JSON.parse(message.Body ?? "{}").jobId;
    validateJobId(jobId);
    stage = "read_job_manifest";
    visibilityTimer = setInterval(() => {
      sqs.send(new ChangeMessageVisibilityCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle, VisibilityTimeout: 120 }))
        .catch((error) => console.error("visibility_refresh_failed", error.name ?? "Error"));
    }, 60_000);
    visibilityTimer.unref();
    const existing = await readJob(jobId);
    if (!existing) throw new Error("job_not_found");
    if (stopping) return;
    if (["completed", "failed", "cancelled", "truncated", "interrupted"].includes(existing.status)) {
      stage = "delete_terminal_queue_message";
      return deleteQueueMessage(message.ReceiptHandle);
    }
    if (existing.status === "running") {
      await writeJob({ ...existing, status: "interrupted", error: "worker_restarted", updatedAt: new Date().toISOString() });
      return deleteQueueMessage(message.ReceiptHandle);
    }

    const active = { session: null, shutdownRequested: false };
    active.done = new Promise((resolve) => { active.resolveDone = resolve; });
    activeJobs.set(jobId, active);
    stage = "check_cancellation";
    if (await objectExists(`cancellations/${jobId}.json`)) {
      stage = "write_cancelled_manifest";
      await writeJob({ ...existing, status: "cancelled", updatedAt: new Date().toISOString() });
      stage = "delete_cancelled_queue_message";
      return deleteQueueMessage(message.ReceiptHandle);
    }

    const running = { ...existing, status: "running", startedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    stage = "write_running_manifest";
    await writeJob(running);
    stage = "read_prompt";
    const { prompt } = await getJson(`inputs/${jobId}.json`);
    stage = "create_copilot_session";
    const session = await copilot.createSession({
      model: existing.model,
      sessionId: jobId,
      streaming: true,
      availableTools: [],
      infiniteSessions: { enabled: false },
    });
    active.session = session;
    generationStarted = true;

    let output = "";
    let pending = "";
    let pendingBytes = 0;
    let outputBytes = 0;
    let truncated = false;
    let timer;
    const flush = () => {
      if (!pending) return;
      broadcast(jobId, { type: "delta", jobId, text: pending });
      pending = "";
      pendingBytes = 0;
    };
    const unsubscribe = session.on("assistant.message_delta", (event) => {
      if (active.shutdownRequested || active.cancelled || truncated) return;
      const delta = event.data.deltaContent ?? "";
      const bytes = Buffer.byteLength(delta, "utf8");
      if (outputBytes + bytes > maxOutputBytes) {
        truncated = true;
        session.abort().catch(() => {});
        return;
      }
      output += delta;
      pending += delta;
      outputBytes += bytes;
      pendingBytes += bytes;
      if (pendingBytes >= 4096) flush();
    });
    timer = setInterval(flush, 100);
    timer.unref();

    let finalStatus = "completed";
    try {
      stage = "copilot_generation";
      await session.sendAndWait({ prompt }, maxJobDurationMs);
      if (truncated) finalStatus = "truncated";
      else if (active.shutdownRequested) finalStatus = "interrupted";
      else if (active.cancelled || await objectExists(`cancellations/${jobId}.json`)) finalStatus = "cancelled";
    } catch (error) {
      if (truncated) finalStatus = "truncated";
      else if (active.shutdownRequested) finalStatus = "interrupted";
      else if (active.cancelled || await objectExists(`cancellations/${jobId}.json`)) finalStatus = "cancelled";
      else throw error;
    } finally {
      clearInterval(timer);
      unsubscribe();
      flush();
    }

    const resultKey = `results/${jobId}.md`;
  stage = "write_result";
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: resultKey, Body: output, ContentType: "text/markdown; charset=utf-8" }));
    const completed = {
      ...running,
      status: finalStatus,
      resultKey,
      bytes: Buffer.byteLength(output, "utf8"),
      updatedAt: new Date().toISOString(),
      ...(finalStatus === "truncated" ? { error: "output_too_large" } : {}),
      ...(finalStatus === "interrupted" ? { error: "service_stopping" } : {}),
    };
    stage = "write_terminal_manifest";
    await writeJob(completed);
    broadcast(jobId, { type: finalStatus, jobId, bytes: completed.bytes, ...(completed.error ? { error: completed.error } : {}) });
    await copilot.deleteSession(jobId).catch(() => {});
    stage = "delete_queue_message";
    await deleteQueueMessage(message.ReceiptHandle);
  } catch (error) {
    console.error("job_failed", JSON.stringify({
      jobId: jobId ?? "unknown",
      stage,
      errorName: error.name ?? "Error",
      errorCode: error.Code ?? error.code ?? error.__type,
      errorMessage: safeErrorMessage(error),
      httpStatusCode: error.$metadata?.httpStatusCode,
      requestId: error.$metadata?.requestId,
    }));
    const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? 1);
    const retryable = !generationStarted && receiveCount < 3;
    const shouldDeadLetter = !generationStarted && receiveCount >= 3;
    if (jobId) {
      const job = await readJob(jobId).catch(() => null);
      if (job && !["completed", "cancelled", "truncated", "interrupted"].includes(job.status)) {
        const updated = {
          ...job,
          status: retryable ? "queued" : "failed",
          error: publicError(error),
          updatedAt: new Date().toISOString(),
        };
        await writeJob(updated).catch(() => {});
        if (!retryable) broadcast(jobId, { type: "failed", jobId, error: updated.error });
      }
      const active = activeJobs.get(jobId);
      if (active?.session) {
        await active.session.disconnect().catch(() => {});
        await copilot.deleteSession(jobId).catch(() => {});
      }
    }
    if (!retryable && !shouldDeadLetter && message.ReceiptHandle) {
      await deleteQueueMessage(message.ReceiptHandle).catch(() => {});
    }
  } finally {
    clearInterval(visibilityTimer);
    if (jobId) {
      const active = activeJobs.get(jobId);
      activeJobs.delete(jobId);
      active?.resolveDone?.();
    }
  }
}

async function readJob(jobId) {
  validateJobId(jobId);
  return getJson(`jobs/${jobId}.json`);
}

async function writeJob(job) {
  await putJson(`jobs/${job.jobId}.json`, job);
}

async function putJson(key, value, onlyIfAbsent = false) {
  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: JSON.stringify(value),
    ContentType: "application/json",
    ...(onlyIfAbsent ? { IfNoneMatch: "*" } : {}),
  }));
}

async function getJson(key) {
  try {
    const result = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    return JSON.parse(await result.Body.transformToString());
  } catch (error) {
    if (error.name === "NoSuchKey" || error.$metadata?.httpStatusCode === 404) return null;
    throw error;
  }
}

async function objectExists(key) {
  return (await getJson(key)) !== null;
}

async function deleteQueueMessage(receiptHandle) {
  if (receiptHandle) await sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: receiptHandle }));
}

function addWatcher(jobId, webSocket) {
  if (!watchers.has(jobId)) watchers.set(jobId, new Set());
  watchers.get(jobId).add(webSocket);
}

function broadcast(jobId, message) {
  for (const webSocket of watchers.get(jobId) ?? []) sendSocket(webSocket, message);
}

function sendSocket(webSocket, message) {
  if (webSocket.readyState === WebSocket.OPEN) webSocket.send(JSON.stringify(message));
}

function sendJson(response, status, body) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

function validateRequestId(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(value)) {
    throw new Error("invalid_request_id");
  }
  return value;
}

function validateJobId(value) {
  if (typeof value !== "string" || !/^job_[0-9a-f-]{36}$/i.test(value)) throw new Error("invalid_job_id");
  return value;
}

function isConditionalConflict(error) {
  return error.name === "PreconditionFailed" || error.name === "ConditionalRequestConflict" || error.$metadata?.httpStatusCode === 412;
}

function publicError(error) {
  const known = new Set(["model_not_allowed", "prompt_required", "prompt_too_large", "invalid_request_id", "invalid_job_id", "job_not_found"]);
  return known.has(error.message) ? error.message : "upstream_error";
}

function safeErrorMessage(error) {
  let message = String(error?.message ?? "").replace(/[\r\n\t]+/g, " ");
  const token = process.env.COPILOT_GITHUB_TOKEN;
  if (token) message = message.replaceAll(token, "[REDACTED]");
  return message
    .replace(/\b(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]+/g, "[REDACTED]")
    .slice(0, 400);
}

async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.info("shutdown_started", signal);
  const activeJobsAtShutdown = [...activeJobs.values()];
  for (const active of activeJobsAtShutdown) {
    active.shutdownRequested = true;
    if (active.session) await active.session.abort().catch(() => {});
  }
  for (const webSocket of webSockets.clients) {
    sendSocket(webSocket, { type: "shutdown", reason: "deploy", graceSeconds: 100 });
  }
  await Promise.race([
    Promise.all(activeJobsAtShutdown.map((active) => active.done)),
    new Promise((resolve) => {
      const timer = setTimeout(resolve, 100_000);
      timer.unref();
    }),
  ]);
  for (const webSocket of webSockets.clients) webSocket.close(1001, "service shutdown");
  await new Promise((resolve) => server.close(resolve));
  await copilot.stop();
  process.exit(0);
}

await copilot.start();
server.listen(port, "0.0.0.0", () => console.info("server_listening", port));
void pollQueue();
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
