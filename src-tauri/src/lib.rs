use std::{
  io::{BufRead, BufReader, Read},
  process::{Command, Stdio},
  sync::{
    atomic::{AtomicUsize, Ordering},
    Arc, Mutex,
  },
  thread,
};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, State};

const EVENT_STREAM_CHUNK: &str = "qwen_stream_chunk";
const EVENT_STREAM_ERROR: &str = "qwen_stream_error";
const EVENT_FIRST_SEND_FAILED: &str = "qwen_first_send_failed";

const FIRST_SEND_FAILED_TITLE: &str = "qwen-cli 不可用";
const FIRST_SEND_FAILED_MESSAGE: &str =
  "未检测到可用的 qwen-cli 或未登录。请在终端运行 qwen 并完成登录后重试。";

#[derive(Default)]
struct QwenState {
  manager: Mutex<QwenSessionManager>,
  active_headless_jobs: Arc<AtomicUsize>,
}

#[derive(Default)]
struct QwenSessionManager {
  first_send_attempted: bool,
  last_failed_input: Option<String>,
  last_failed_openai_config: Option<OpenAiConfig>,
  last_failed_headless_config: Option<HeadlessConfig>,
  session_headless_config: Option<HeadlessConfig>,
  generation_round: u64,
}

struct ActiveHeadlessJobGuard {
  counter: Arc<AtomicUsize>,
}

impl ActiveHeadlessJobGuard {
  fn new(counter: Arc<AtomicUsize>) -> Self {
    counter.fetch_add(1, Ordering::SeqCst);
    Self { counter }
  }
}

impl Drop for ActiveHeadlessJobGuard {
  fn drop(&mut self) {
    self.counter.fetch_sub(1, Ordering::SeqCst);
  }
}

#[derive(Default)]
struct StreamSummary {
  emitted_any_chunk: bool,
  emitted_partial_chunk: bool,
  emitted_full_message: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SendAck {
  ok: bool,
  round_id: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RetryAck {
  ok: bool,
  resent: bool,
  round_id: Option<u64>,
}

#[derive(Serialize)]
struct SessionStatus {
  running: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct StreamChunkPayload {
  round_id: u64,
  chunk: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct StreamErrorPayload {
  round_id: u64,
  kind: String,
  message: String,
}

#[derive(Clone, Serialize)]
struct FirstSendFailedPayload {
  title: String,
  message: String,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OpenAiConfig {
  openai_api_key: Option<String>,
  openai_base_url: Option<String>,
  openai_model: Option<String>,
}

impl OpenAiConfig {
  fn is_empty(&self) -> bool {
    self.openai_api_key.is_none() && self.openai_base_url.is_none() && self.openai_model.is_none()
  }
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct HeadlessConfig {
  working_directory: Option<String>,
  approval_mode: Option<String>,
}

impl HeadlessConfig {
  fn is_empty(&self) -> bool {
    self.working_directory.is_none() && self.approval_mode.is_none()
  }
}

fn sanitize_optional_env_value(value: Option<String>) -> Option<String> {
  value.and_then(|raw| {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
      None
    } else {
      Some(trimmed.to_string())
    }
  })
}

fn sanitize_approval_mode(mode: Option<String>) -> Option<String> {
  let Some(trimmed) = sanitize_optional_env_value(mode) else {
    return None;
  };

  match trimmed.as_str() {
    "default" | "auto-edit" | "yolo" | "plan" => Some(trimmed),
    _ => {
      log::warn!("[mew] ignored unsupported approval mode for qwen headless session: {trimmed}");
      None
    }
  }
}

fn sanitize_headless_config(config: Option<HeadlessConfig>) -> Option<HeadlessConfig> {
  config.and_then(|raw| {
    let sanitized = HeadlessConfig {
      working_directory: sanitize_optional_env_value(raw.working_directory),
      approval_mode: sanitize_approval_mode(raw.approval_mode),
    };

    if sanitized.is_empty() {
      None
    } else {
      Some(sanitized)
    }
  })
}

fn sanitize_openai_config(config: Option<OpenAiConfig>) -> Option<OpenAiConfig> {
  config.and_then(|raw| {
    let sanitized = OpenAiConfig {
      openai_api_key: sanitize_optional_env_value(raw.openai_api_key),
      openai_base_url: sanitize_optional_env_value(raw.openai_base_url),
      openai_model: sanitize_optional_env_value(raw.openai_model),
    };

    if sanitized.is_empty() {
      None
    } else {
      Some(sanitized)
    }
  })
}

fn apply_qwen_env_overrides(command: &mut Command, openai_config: Option<&OpenAiConfig>) {
  let mut removed_ci_keys = 0usize;

  for (key, _) in std::env::vars_os() {
    let Some(key_str) = key.to_str() else {
      continue;
    };

    if key_str == "CI" || key_str == "CONTINUOUS_INTEGRATION" || key_str.starts_with("CI_") {
      command.env_remove(&key);
      removed_ci_keys = removed_ci_keys.saturating_add(1);
    }
  }

  if removed_ci_keys > 0 {
    log::info!("[mew] removed {removed_ci_keys} CI-related env vars for qwen headless session");
  }

  if std::env::var_os("TERM").is_none() {
    command.env("TERM", "xterm-256color");
    log::info!("[mew] TERM was missing; set TERM=xterm-256color for qwen headless session");
  }

  if let Some(config) = openai_config {
    let mut applied_overrides: Vec<&str> = Vec::new();

    if let Some(api_key) = &config.openai_api_key {
      command.env("OPENAI_API_KEY", api_key);
      applied_overrides.push("OPENAI_API_KEY");
    }
    if let Some(base_url) = &config.openai_base_url {
      command.env("OPENAI_BASE_URL", base_url);
      applied_overrides.push("OPENAI_BASE_URL");
    }
    if let Some(model) = &config.openai_model {
      command.env("OPENAI_MODEL", model);
      applied_overrides.push("OPENAI_MODEL");
    }

    if !applied_overrides.is_empty() {
      log::info!(
        "[mew] applied OpenAI-compatible env overrides for qwen headless session: {}",
        applied_overrides.join(", ")
      );
    }
  }
}

fn apply_qwen_cli_overrides(command: &mut Command, headless_config: Option<&HeadlessConfig>) {
  let Some(config) = headless_config else {
    return;
  };

  if let Some(working_directory) = &config.working_directory {
    command.current_dir(working_directory);
    command.arg("--include-directories").arg(working_directory);
    log::info!("[mew] applied qwen working directory for headless session: {working_directory}");
  }

  if let Some(approval_mode) = &config.approval_mode {
    command.arg("--approval-mode").arg(approval_mode);
    log::info!("[mew] applied qwen approval mode for headless session: {approval_mode}");
  }
}

fn build_qwen_headless_command(prompt: &str, use_continue: bool) -> Command {
  #[cfg(target_os = "windows")]
  let mut command = {
    let mut cmd = Command::new("cmd.exe");
    cmd.arg("/C");
    cmd.arg("qwen.cmd");
    cmd
  };

  #[cfg(not(target_os = "windows"))]
  let mut command = Command::new("qwen");

  command
    .arg("-p")
    .arg(prompt)
    .arg("--output-format")
    .arg("stream-json")
    .arg("--include-partial-messages");

  if use_continue {
    command.arg("--continue");
  }

  command
}

fn emit_stream_chunk(app: &AppHandle, round_id: u64, chunk: String) {
  if chunk.is_empty() {
    return;
  }

  let _ = app.emit(EVENT_STREAM_CHUNK, StreamChunkPayload { round_id, chunk });
}

fn emit_stream_error(app: &AppHandle, round_id: u64, kind: &str, message: String) {
  let _ = app.emit(
    EVENT_STREAM_ERROR,
    StreamErrorPayload {
      round_id,
      kind: kind.to_string(),
      message,
    },
  );
}

fn normalize_text_chunk(text: &str) -> Option<String> {
  if text.is_empty() {
    return None;
  }

  Some(text.to_string())
}

fn value_at_pointer_as_str<'a>(value: &'a Value, pointer: &str) -> Option<&'a str> {
  value.pointer(pointer).and_then(Value::as_str)
}

fn extract_partial_text_from_event(event: &Value) -> Option<String> {
  let candidates = [
    "/delta/text",
    "/content_block/text",
    "/message/text",
    "/text",
    "/delta",
  ];

  for pointer in candidates {
    if let Some(text) = value_at_pointer_as_str(event, pointer).and_then(normalize_text_chunk) {
      return Some(text);
    }
  }

  None
}

fn extract_message_text(content: &Value) -> Option<String> {
  match content {
    Value::String(text) => normalize_text_chunk(text),
    Value::Array(items) => {
      let mut merged = String::new();

      for item in items {
        if let Some(text) = item.get("text").and_then(Value::as_str) {
          merged.push_str(text);
          continue;
        }

        if let Some(text) = item.as_str() {
          merged.push_str(text);
        }
      }

      normalize_text_chunk(&merged)
    }
    _ => None,
  }
}

fn extract_stream_chunk_from_json(value: &Value, summary: &mut StreamSummary) -> Option<String> {
  if let Some(event) = value.get("event") {
    if let Some(partial_text) = extract_partial_text_from_event(event) {
      summary.emitted_partial_chunk = true;
      return Some(partial_text);
    }
  }

  if summary.emitted_partial_chunk {
    return None;
  }

  let value_type = value.get("type").and_then(Value::as_str);
  if value_type == Some("assistant") {
    let message_text = value
      .pointer("/message/content")
      .and_then(extract_message_text)
      .or_else(|| value.pointer("/message/text").and_then(Value::as_str).and_then(normalize_text_chunk));
    if let Some(text) = message_text {
      summary.emitted_full_message = true;
      return Some(text);
    }
  }

  if !summary.emitted_full_message && value_type == Some("result") {
    let result_text = value.get("result").and_then(Value::as_str).and_then(normalize_text_chunk);
    if let Some(text) = result_text {
      summary.emitted_full_message = true;
      return Some(text);
    }
  }

  None
}

fn stream_headless_stdout(app: &AppHandle, round_id: u64, stdout: impl Read) -> Result<StreamSummary, String> {
  let mut reader = BufReader::new(stdout);
  let mut line = String::new();
  let mut summary = StreamSummary::default();

  loop {
    line.clear();
    let read = reader
      .read_line(&mut line)
      .map_err(|err| format!("failed reading qwen headless stdout: {err}"))?;
    if read == 0 {
      break;
    }

    let trimmed = line.trim_end_matches(['\r', '\n']);
    if trimmed.is_empty() {
      continue;
    }

    if let Ok(value) = serde_json::from_str::<Value>(trimmed) {
      if let Some(chunk) = extract_stream_chunk_from_json(&value, &mut summary) {
        summary.emitted_any_chunk = true;
        emit_stream_chunk(app, round_id, chunk);
      }
      continue;
    }

    summary.emitted_any_chunk = true;
    emit_stream_chunk(app, round_id, format!("{trimmed}\n"));
  }

  Ok(summary)
}

fn read_stream_to_string(mut stream: impl Read) -> String {
  let mut content = String::new();
  if stream.read_to_string(&mut content).is_err() {
    return String::new();
  }
  content
}

fn spawn_headless_round(
  app: AppHandle,
  round_id: u64,
  input: String,
  use_continue: bool,
  openai_config: Option<OpenAiConfig>,
  headless_config: Option<HeadlessConfig>,
  active_headless_jobs: Arc<AtomicUsize>,
) -> Result<(), String> {
  let mut command = build_qwen_headless_command(&input, use_continue);
  apply_qwen_cli_overrides(&mut command, headless_config.as_ref());
  apply_qwen_env_overrides(&mut command, openai_config.as_ref());
  command.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());

  log::info!("[mew] spawning qwen headless process for round_id={round_id}, continue={use_continue}");
  let mut child = command
    .spawn()
    .map_err(|err| format!("failed to start qwen headless process: {err}"))?;
  log::info!("[mew] qwen headless process spawned for round_id={round_id}");

  let stdout = child
    .stdout
    .take()
    .ok_or_else(|| "failed to capture qwen stdout".to_string())?;
  let stderr = child
    .stderr
    .take()
    .ok_or_else(|| "failed to capture qwen stderr".to_string())?;

  thread::spawn(move || {
    let _active_job_guard = ActiveHeadlessJobGuard::new(active_headless_jobs);

    let stderr_handle = thread::spawn(move || read_stream_to_string(stderr));
    let summary = stream_headless_stdout(&app, round_id, stdout);
    let wait_result = child.wait();

    let stderr_output = stderr_handle.join().unwrap_or_else(|_| String::new());

    let summary = match summary {
      Ok(summary) => summary,
      Err(err) => {
        log::warn!("[mew] failed streaming qwen output for round_id={round_id}: {err}");
        emit_stream_error(&app, round_id, "stdout_read_error", err);
        return;
      }
    };
    match wait_result {
      Ok(status) if status.success() => {
        if !summary.emitted_any_chunk {
          let message = if stderr_output.trim().is_empty() {
            "qwen completed without output".to_string()
          } else {
            format!("qwen completed without stdout. stderr: {}", stderr_output.trim())
          };
          log::warn!("[mew] qwen returned no output for round_id={round_id}: {message}");
          emit_stream_error(&app, round_id, "empty_output", message);
        } else {
          log::info!("[mew] qwen headless round completed, round_id={round_id}");
        }
      }
      Ok(status) => {
        let status_code = status
          .code()
          .map(|code| code.to_string())
          .unwrap_or_else(|| "terminated by signal".to_string());
        let message = if stderr_output.trim().is_empty() {
          format!("qwen exited with non-zero status: {status_code}")
        } else {
          format!(
            "qwen exited with non-zero status: {status_code}, stderr: {}",
            stderr_output.trim()
          )
        };
        log::warn!("[mew] qwen headless round failed, round_id={round_id}: {message}");
        emit_stream_error(&app, round_id, "command_failed", message);
      }
      Err(err) => {
        let message = format!("failed waiting qwen process: {err}");
        log::warn!("[mew] qwen headless wait failed for round_id={round_id}: {message}");
        emit_stream_error(&app, round_id, "wait_error", message);
      }
    }
  });

  Ok(())
}

#[tauri::command]
fn qwen_send(
  app: AppHandle,
  state: State<'_, QwenState>,
  input: String,
  openai_config: Option<OpenAiConfig>,
  headless_config: Option<HeadlessConfig>,
) -> Result<SendAck, String> {
  let mut manager = state
    .manager
    .lock()
    .map_err(|_| "failed to lock qwen manager".to_string())?;

  let is_first_attempt = !manager.first_send_attempted;
  manager.first_send_attempted = true;
  manager.generation_round = manager.generation_round.saturating_add(1);
  let round_id = manager.generation_round;
  let sanitized_openai_config = sanitize_openai_config(openai_config);
  let sanitized_headless_config = sanitize_headless_config(headless_config);

  let use_continue = round_id > 1 && manager.session_headless_config == sanitized_headless_config;
  if round_id > 1 && !use_continue {
    log::info!("[mew] headless config changed; restarting qwen session without --continue, round_id={round_id}");
  }
  match spawn_headless_round(
    app.clone(),
    round_id,
    input.clone(),
    use_continue,
    sanitized_openai_config.clone(),
    sanitized_headless_config.clone(),
    state.active_headless_jobs.clone(),
  ) {
    Ok(()) => {
      manager.last_failed_input = None;
      manager.last_failed_openai_config = None;
      manager.last_failed_headless_config = None;
      if !use_continue {
        manager.session_headless_config = sanitized_headless_config.clone();
      }
      log::info!("[mew] qwen_send accepted in headless mode, round_id={round_id}");
      Ok(SendAck { ok: true, round_id })
    }
    Err(err) => {
      manager.last_failed_input = Some(input);
      manager.last_failed_openai_config = sanitized_openai_config;
      manager.last_failed_headless_config = sanitized_headless_config;
      log::warn!("[mew] qwen_send failed in headless mode: {err}");

      if is_first_attempt {
        let _ = app.emit(
          EVENT_FIRST_SEND_FAILED,
          FirstSendFailedPayload {
            title: FIRST_SEND_FAILED_TITLE.to_string(),
            message: FIRST_SEND_FAILED_MESSAGE.to_string(),
          },
        );
      }

      Err(err)
    }
  }
}

#[tauri::command]
fn qwen_retry_last(app: AppHandle, state: State<'_, QwenState>) -> Result<RetryAck, String> {
  let mut manager = state
    .manager
    .lock()
    .map_err(|_| "failed to lock qwen manager".to_string())?;

  let Some(last_input) = manager.last_failed_input.clone() else {
    return Ok(RetryAck {
      ok: true,
      resent: false,
      round_id: None,
    });
  };

  manager.generation_round = manager.generation_round.saturating_add(1);
  let round_id = manager.generation_round;
  let last_openai_config = manager.last_failed_openai_config.clone();
  let last_headless_config = manager.last_failed_headless_config.clone();

  let use_continue = round_id > 1 && manager.session_headless_config == last_headless_config;
  match spawn_headless_round(
    app,
    round_id,
    last_input.clone(),
    use_continue,
    last_openai_config.clone(),
    last_headless_config.clone(),
    state.active_headless_jobs.clone(),
  ) {
    Ok(()) => {
      manager.last_failed_input = None;
      manager.last_failed_openai_config = None;
      manager.last_failed_headless_config = None;
      if !use_continue {
        manager.session_headless_config = last_headless_config.clone();
      }
      Ok(RetryAck {
        ok: true,
        resent: true,
        round_id: Some(round_id),
      })
    }
    Err(_) => {
      manager.last_failed_input = Some(last_input);
      manager.last_failed_openai_config = last_openai_config;
      manager.last_failed_headless_config = last_headless_config;
      Ok(RetryAck {
        ok: false,
        resent: false,
        round_id: None,
      })
    }
  }
}

#[tauri::command]
fn qwen_status(state: State<'_, QwenState>) -> Result<SessionStatus, String> {
  Ok(SessionStatus {
    running: state.active_headless_jobs.load(Ordering::SeqCst) > 0,
  })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .manage(QwenState::default())
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }

      Ok(())
    })
    .invoke_handler(tauri::generate_handler![qwen_send, qwen_retry_last, qwen_status])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
