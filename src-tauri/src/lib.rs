use std::{
  io::{Read, Write},
  sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc, Mutex,
  },
  thread,
};

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

const EVENT_STREAM_CHUNK: &str = "qwen_stream_chunk";
const EVENT_STREAM_ERROR: &str = "qwen_stream_error";
const EVENT_SESSION_INTERRUPTED: &str = "qwen_session_interrupted";
const EVENT_FIRST_SEND_FAILED: &str = "qwen_first_send_failed";

const FIRST_SEND_FAILED_TITLE: &str = "qwen-cli 不可用";
const FIRST_SEND_FAILED_MESSAGE: &str =
  "未检测到可用的 qwen-cli 或未登录。请在终端运行 qwen 并完成登录后重试。";
const SESSION_INTERRUPTED_MESSAGE: &str = "会话已中断，请重试";

#[derive(Default)]
struct QwenState {
  manager: Mutex<QwenSessionManager>,
}

#[derive(Default)]
struct QwenSessionManager {
  session: Option<QwenSession>,
  first_send_attempted: bool,
  last_failed_input: Option<String>,
  generation_round: u64,
}

struct QwenSession {
  _master: Box<dyn MasterPty + Send>,
  writer: Mutex<Box<dyn Write + Send>>,
  child: Box<dyn Child + Send>,
  alive: Arc<AtomicBool>,
  current_round: Arc<AtomicU64>,
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StreamChunkPayload {
  round_id: u64,
  chunk: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StreamErrorPayload {
  round_id: u64,
  kind: String,
  message: String,
}

#[derive(Serialize)]
struct SessionInterruptedPayload {
  message: String,
}

#[derive(Serialize)]
struct FirstSendFailedPayload {
  title: String,
  message: String,
}

impl QwenSession {
  fn spawn(app: AppHandle, initial_round: u64) -> Result<Self, String> {
    let pty_system = native_pty_system();
    let mut pair = pty_system
      .openpty(PtySize {
        rows: 30,
        cols: 120,
        pixel_width: 0,
        pixel_height: 0,
      })
      .map_err(|err| format!("failed to open pty: {err}"))?;

    let cmd = CommandBuilder::new("qwen");
    let child = pair
      .slave
      .spawn_command(cmd)
      .map_err(|err| format!("failed to start qwen: {err}"))?;

    let reader = pair
      .master
      .try_clone_reader()
      .map_err(|err| format!("failed to clone pty reader: {err}"))?;
    let writer = pair
      .master
      .take_writer()
      .map_err(|err| format!("failed to acquire pty writer: {err}"))?;

    let alive = Arc::new(AtomicBool::new(true));
    let current_round = Arc::new(AtomicU64::new(initial_round));

    spawn_reader_thread(app, reader, alive.clone(), current_round.clone());

    Ok(Self {
      _master: pair.master,
      writer: Mutex::new(writer),
      child,
      alive,
      current_round,
    })
  }

  fn set_round(&self, round_id: u64) {
    self.current_round.store(round_id, Ordering::SeqCst);
  }

  fn write_line(&self, input: &str) -> Result<(), String> {
    if !self.alive.load(Ordering::SeqCst) {
      return Err("qwen session is not alive".to_string());
    }

    let mut writer = self
      .writer
      .lock()
      .map_err(|_| "failed to lock qwen writer".to_string())?;

    writer
      .write_all(input.as_bytes())
      .map_err(|err| format!("failed writing to qwen stdin: {err}"))?;
    writer
      .write_all(b"\n")
      .map_err(|err| format!("failed writing newline to qwen stdin: {err}"))?;
    writer
      .flush()
      .map_err(|err| format!("failed flushing qwen stdin: {err}"))?;

    Ok(())
  }

  fn refresh_alive_status(&mut self) -> bool {
    if !self.alive.load(Ordering::SeqCst) {
      return false;
    }

    match self.child.try_wait() {
      Ok(Some(_)) => {
        self.alive.store(false, Ordering::SeqCst);
        false
      }
      Ok(None) => true,
      Err(_) => {
        self.alive.store(false, Ordering::SeqCst);
        false
      }
    }
  }
}

impl Drop for QwenSession {
  fn drop(&mut self) {
    self.alive.store(false, Ordering::SeqCst);
    let _ = self.child.kill();
    let _ = self.child.wait();
  }
}

impl QwenSessionManager {
  fn ensure_session(&mut self, app: &AppHandle) -> Result<(), String> {
    let should_spawn = match self.session.as_mut() {
      Some(session) => !session.refresh_alive_status(),
      None => true,
    };

    if should_spawn {
      self.session = None;
      let next_session = QwenSession::spawn(app.clone(), self.generation_round)?;
      self.session = Some(next_session);
    }

    Ok(())
  }

  fn send_input(&mut self, app: &AppHandle, input: &str) -> Result<u64, String> {
    self.ensure_session(app)?;
    self.generation_round = self.generation_round.saturating_add(1);
    let round_id = self.generation_round;

    let session = self
      .session
      .as_mut()
      .ok_or_else(|| "qwen session missing".to_string())?;
    session.set_round(round_id);
    session.write_line(input)?;

    Ok(round_id)
  }

  fn restart(&mut self) {
    self.session = None;
  }

  fn status(&mut self) -> bool {
    self
      .session
      .as_mut()
      .is_some_and(QwenSession::refresh_alive_status)
  }
}

fn spawn_reader_thread(
  app: AppHandle,
  mut reader: Box<dyn Read + Send>,
  alive: Arc<AtomicBool>,
  current_round: Arc<AtomicU64>,
) {
  thread::spawn(move || {
    let mut buffer = [0_u8; 4096];

    loop {
      match reader.read(&mut buffer) {
        Ok(0) => {
          alive.store(false, Ordering::SeqCst);
          let round_id = current_round.load(Ordering::SeqCst);
          if round_id > 0 {
            let _ = app.emit(
              EVENT_SESSION_INTERRUPTED,
              SessionInterruptedPayload {
                message: SESSION_INTERRUPTED_MESSAGE.to_string(),
              },
            );
          }
          break;
        }
        Ok(size) => {
          let round_id = current_round.load(Ordering::SeqCst);
          if round_id == 0 {
            continue;
          }

          let chunk = String::from_utf8_lossy(&buffer[..size]).to_string();
          let _ = app.emit(EVENT_STREAM_CHUNK, StreamChunkPayload { round_id, chunk });
        }
        Err(err) => {
          alive.store(false, Ordering::SeqCst);
          let round_id = current_round.load(Ordering::SeqCst);
          if round_id > 0 {
            let _ = app.emit(
              EVENT_STREAM_ERROR,
              StreamErrorPayload {
                round_id,
                kind: "read_error".to_string(),
                message: format!("failed reading qwen output: {err}"),
              },
            );
            let _ = app.emit(
              EVENT_SESSION_INTERRUPTED,
              SessionInterruptedPayload {
                message: SESSION_INTERRUPTED_MESSAGE.to_string(),
              },
            );
          }
          break;
        }
      }
    }
  });
}

#[tauri::command]
fn qwen_send(app: AppHandle, state: State<'_, QwenState>, input: String) -> Result<SendAck, String> {
  let mut manager = state
    .manager
    .lock()
    .map_err(|_| "failed to lock qwen manager".to_string())?;

  let is_first_attempt = !manager.first_send_attempted;
  manager.first_send_attempted = true;

  match manager.send_input(&app, &input) {
    Ok(round_id) => {
      manager.last_failed_input = None;
      Ok(SendAck { ok: true, round_id })
    }
    Err(err) => {
      manager.last_failed_input = Some(input);
      manager.restart();

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

  manager.restart();
  match manager.send_input(&app, &last_input) {
    Ok(round_id) => {
      manager.last_failed_input = None;
      Ok(RetryAck {
        ok: true,
        resent: true,
        round_id: Some(round_id),
      })
    }
    Err(_) => {
      manager.last_failed_input = Some(last_input);
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
  let mut manager = state
    .manager
    .lock()
    .map_err(|_| "failed to lock qwen manager".to_string())?;

  Ok(SessionStatus {
    running: manager.status(),
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

      let state = app.state::<QwenState>();
      if let Ok(mut manager) = state.manager.lock() {
        if let Err(err) = manager.ensure_session(&app.handle().clone()) {
          log::warn!("[mew] failed to prewarm qwen session: {err}");
        }
      } else {
        log::warn!("[mew] failed to lock qwen manager during setup");
      }

      Ok(())
    })
    .invoke_handler(tauri::generate_handler![qwen_send, qwen_retry_last, qwen_status])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
