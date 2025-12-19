use std::sync::{mpsc, Arc, atomic::{AtomicBool, Ordering}};
use std::thread;
use std::time::Duration;
use std::io::{self, Read, Write};
use base64::prelude::*;

use ratatui::layout::{Constraint, Direction, Layout, Alignment};
use ratatui::style::{Color, Modifier, Style};
use ratatui::widgets::{Block, Borders, List, ListItem, Paragraph, Wrap, Gauge};
use ratatui::Frame;
use crossterm::event::KeyCode;

use serialport::SerialPort;

#[derive(Debug, Clone)]
pub enum SerialStatus {
    Idle,
    Scanning,
    Downloading(String), // filename
    Connecting,
    Uploading(String, u64, u64), // filename, written, total
    Done,
    Error(String),
}

pub struct SerialTab {
    pub ports: Vec<String>,
    pub selected_port: usize,
    pub status: SerialStatus,
    pub logs: Vec<String>,
    pub progress: f64,
    
    // Worker communication
    tx: Option<mpsc::Sender<SerialCmd>>,
    rx: Option<mpsc::Receiver<SerialMsg>>,
}

enum SerialCmd {
    StartUpdate(String), // port name
}

pub enum SerialMsg {
    Log(String),
    Status(SerialStatus),
    Progress(f64),
}

impl SerialTab {
    pub fn new() -> Self {
        Self {
            ports: Vec::new(),
            selected_port: 0,
            status: SerialStatus::Idle,
            logs: Vec::new(),
            progress: 0.0,
            tx: None,
            rx: None,
        }
    }

    pub fn init(&mut self) {
        self.scan_ports();
    }

    pub fn scan_ports(&mut self) {
        self.ports.clear();
        if let Ok(ports) = serialport::available_ports() {
            for p in ports {
                self.ports.push(p.port_name);
            }
        }
        if self.ports.is_empty() {
            self.log("No serial ports found");
        } else {
            self.log(format!("Found {} serial ports", self.ports.len()));
        }
        self.selected_port = 0;
    }

    pub fn log(&mut self, msg: impl Into<String>) {
        self.logs.push(msg.into());
        if self.logs.len() > 100 {
            self.logs.remove(0);
        }
    }

    pub fn update(&mut self) {
        // Check for messages from worker
        let mut msgs = Vec::new();
        if let Some(rx) = &self.rx {
            while let Ok(msg) = rx.try_recv() {
                msgs.push(msg);
            }
        }
        
        for msg in msgs {
            match msg {
                SerialMsg::Log(s) => self.log(s),
                SerialMsg::Status(s) => self.status = s,
                SerialMsg::Progress(p) => self.progress = p,
            }
        }
    }

    pub fn handle_input(&mut self, key: KeyCode) {
        match key {
            KeyCode::Char('r') => self.scan_ports(),
            KeyCode::Char('j') | KeyCode::Down => {
                if !self.ports.is_empty() {
                    self.selected_port = (self.selected_port + 1) % self.ports.len();
                }
            }
            KeyCode::Char('k') | KeyCode::Up => {
                if !self.ports.is_empty() {
                    self.selected_port = (self.selected_port + self.ports.len() - 1) % self.ports.len();
                }
            }
            KeyCode::Char('u') => {
                if let SerialStatus::Idle | SerialStatus::Done | SerialStatus::Error(_) = self.status {
                    if !self.ports.is_empty() {
                        self.start_update();
                    } else {
                        self.log("No port selected");
                    }
                }
            }
            _ => {}
        }
    }

    fn start_update(&mut self) {
        let port_name = self.ports[self.selected_port].clone();
        self.status = SerialStatus::Downloading("Starting...".into());
        self.progress = 0.0;
        
        let (tx_cmd, rx_cmd) = mpsc::channel();
        let (tx_msg, rx_msg) = mpsc::channel();
        
        self.tx = Some(tx_cmd);
        self.rx = Some(rx_msg);

        thread::spawn(move || {
            run_update_worker(port_name, tx_msg);
        });
    }

    pub fn render(&self, f: &mut Frame, area: ratatui::layout::Rect) {
        let chunks = Layout::default()
            .direction(Direction::Vertical)
            .constraints([Constraint::Length(3), Constraint::Min(0), Constraint::Length(10)].as_ref())
            .split(area);

        let header = Paragraph::new("Press 'r' to rescan ports • 'u' to update firmware • 'q' to quit")
            .block(Block::default().borders(Borders::ALL).title("Serial Update"))
            .alignment(Alignment::Center);
        f.render_widget(header, chunks[0]);

        let main_chunks = Layout::default()
            .direction(Direction::Horizontal)
            .constraints([Constraint::Percentage(30), Constraint::Percentage(70)].as_ref())
            .split(chunks[1]);

        // Ports list
        let items: Vec<ListItem> = self.ports.iter().map(|p| ListItem::new(p.clone())).collect();
        let ports_list = List::new(items)
            .block(Block::default().borders(Borders::ALL).title("Ports"))
            .highlight_style(Style::default().add_modifier(Modifier::BOLD).fg(Color::Yellow))
            .highlight_symbol(">> ");
        let mut state = ratatui::widgets::ListState::default();
        if !self.ports.is_empty() {
            state.select(Some(self.selected_port));
        }
        f.render_stateful_widget(ports_list, main_chunks[0], &mut state);

        // Status / Details
        let status_text = match &self.status {
            SerialStatus::Idle => "Idle".to_string(),
            SerialStatus::Scanning => "Scanning...".to_string(),
            SerialStatus::Downloading(f) => format!("Downloading: {}", f),
            SerialStatus::Connecting => "Connecting to device...".to_string(),
            SerialStatus::Uploading(f, w, t) => format!("Uploading {}: {}/{}", f, w, t),
            SerialStatus::Done => "Update Complete!".to_string(),
            SerialStatus::Error(e) => format!("Error: {}", e),
        };

        let mut details = format!("Status: {}\n\n", status_text);
        if let SerialStatus::Uploading(_, _, _) | SerialStatus::Downloading(_) = self.status {
             details.push_str(&format!("Progress: {:.1}%\n", self.progress * 100.0));
        }

        let info = Paragraph::new(details)
            .block(Block::default().borders(Borders::ALL).title("Status"))
            .wrap(Wrap { trim: true });
        f.render_widget(info, main_chunks[1]);

        // Logs
        let log_items: Vec<ListItem> = self.logs.iter().rev().take(chunks[2].height as usize - 2).map(|s| ListItem::new(s.clone())).collect();
        let logs = List::new(log_items)
            .block(Block::default().borders(Borders::ALL).title("Logs"));
        f.render_widget(logs, chunks[2]);
        
        // Progress Bar Popup
        if let SerialStatus::Downloading(_) | SerialStatus::Uploading(_, _, _) = self.status {
             let gauge_area = centered_rect(60, 20, area);
             let gauge = Gauge::default()
                .block(Block::default().borders(Borders::ALL).title("Updating..."))
                .gauge_style(Style::default().fg(Color::Cyan))
                .ratio(self.progress.clamp(0.0, 1.0))
                .label(format!("{:.1}%", self.progress * 100.0));
             f.render_widget(gauge, gauge_area);
        }
    }
}

fn centered_rect(percent_x: u16, percent_y: u16, r: ratatui::layout::Rect) -> ratatui::layout::Rect {
    let popup_layout = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Percentage((100 - percent_y) / 2),
            Constraint::Percentage(percent_y),
            Constraint::Percentage((100 - percent_y) / 2),
        ])
        .split(r);
    let vertical = popup_layout[1];
    let horizontal = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([
            Constraint::Percentage((100 - percent_x) / 2),
            Constraint::Percentage(percent_x),
            Constraint::Percentage((100 - percent_x) / 2),
        ])
        .split(vertical);
    horizontal[1]
}

// --- Worker Logic ---

fn run_update_worker(port_name: String, tx: mpsc::Sender<SerialMsg>) {
    let _ = tx.send(SerialMsg::Log(format!("Starting update on {}", port_name)));

    // 1. Fetch file list
    let _ = tx.send(SerialMsg::Status(SerialStatus::Downloading("Manifest".into())));
    let files = match fetch_github_files() {
        Ok(f) => f,
        Err(e) => {
            let _ = tx.send(SerialMsg::Status(SerialStatus::Error(e.to_string())));
            return;
        }
    };
    let _ = tx.send(SerialMsg::Log(format!("Found {} files to update", files.len())));

    // 2. Download files content
    let mut file_contents = Vec::new();
    for (i, file) in files.iter().enumerate() {
        let _ = tx.send(SerialMsg::Status(SerialStatus::Downloading(file.path.clone())));
        let _ = tx.send(SerialMsg::Progress(i as f64 / files.len() as f64));
        
        match reqwest::blocking::get(&file.download_url) {
            Ok(resp) => {
                match resp.bytes() {
                    Ok(bytes) => file_contents.push((file.path.clone(), bytes.to_vec())),
                    Err(e) => {
                        let _ = tx.send(SerialMsg::Status(SerialStatus::Error(format!("Failed to read {}: {}", file.path, e))));
                        return;
                    }
                }
            }
            Err(e) => {
                let _ = tx.send(SerialMsg::Status(SerialStatus::Error(format!("Failed to download {}: {}", file.path, e))));
                return;
            }
        }
    }

    // 3. Connect to Serial
    let _ = tx.send(SerialMsg::Status(SerialStatus::Connecting));
    let mut port = match serialport::new(&port_name, 115200)
        .timeout(Duration::from_millis(1000))
        .open() {
        Ok(p) => p,
        Err(e) => {
            let _ = tx.send(SerialMsg::Status(SerialStatus::Error(format!("Failed to open port: {}", e))));
            return;
        }
    };

    // 4. Enter Raw REPL
    if let Err(e) = enter_raw_repl(&mut *port) {
        let _ = tx.send(SerialMsg::Status(SerialStatus::Error(format!("Failed to enter REPL: {}", e))));
        return;
    }
    let _ = tx.send(SerialMsg::Log("Entered Raw REPL".into()));

    // 5. Upload files
    let total_files = file_contents.len();
    for (i, (name, content)) in file_contents.iter().enumerate() {
        let _ = tx.send(SerialMsg::Status(SerialStatus::Uploading(name.clone(), 0, content.len() as u64)));
        let _ = tx.send(SerialMsg::Progress(i as f64 / total_files as f64));
        
        if let Err(e) = upload_file(&mut *port, name, content) {
             let _ = tx.send(SerialMsg::Status(SerialStatus::Error(format!("Failed to upload {}: {}", name, e))));
             return;
        }
        let _ = tx.send(SerialMsg::Log(format!("Uploaded {}", name)));
    }

    // 6. Reset
    let _ = tx.send(SerialMsg::Log("Resetting device...".into()));
    let _ = soft_reset(&mut *port);

    let _ = tx.send(SerialMsg::Status(SerialStatus::Done));
    let _ = tx.send(SerialMsg::Progress(1.0));
}

#[derive(serde::Deserialize, Debug, Clone)]
struct GithubItem {
    name: String,
    path: String,
    download_url: Option<String>,
    #[serde(rename = "type")]
    item_type: String,
}

#[derive(Debug, Clone)]
struct DeviceFile {
    path: String,
    download_url: String,
}

fn fetch_github_files() -> Result<Vec<DeviceFile>, Box<dyn std::error::Error>> {
    let client = reqwest::blocking::Client::builder()
        .user_agent("prototype-badge-flasher")
        .build()?;
    
    let mut files = Vec::new();
    scan_recursive(&client, "code/embedded", &mut files)?;
    Ok(files)
}

fn scan_recursive(client: &reqwest::blocking::Client, path: &str, files: &mut Vec<DeviceFile>) -> Result<(), Box<dyn std::error::Error>> {
    let url = format!("https://api.github.com/repos/mpkendall/prototype-badge/contents/{}?ref=main", path);
    let resp = client.get(&url).send()?;
    let items: Vec<GithubItem> = resp.json()?;

    for item in items {
        if item.name == ".DS_Store" || item.path.contains("__MACOSX") {
            continue;
        }

        if item.item_type == "file" {
            if let Some(url) = item.download_url {
                let rel_path = item.path.trim_start_matches("code/embedded");
                let device_path = if rel_path.starts_with('/') {
                    rel_path.to_string()
                } else {
                    format!("/{}", rel_path)
                };
                files.push(DeviceFile {
                    path: device_path,
                    download_url: url,
                });
            }
        } else if item.item_type == "dir" {
            scan_recursive(client, &item.path, files)?;
        }
    }
    Ok(())
}

// --- Serial Helpers ---

fn read_until(port: &mut dyn SerialPort, target: &[u8], timeout: Duration) -> Result<Vec<u8>, String> {
    let mut buf = [0u8; 1];
    let mut result = Vec::new();
    let start = std::time::Instant::now();
    
    loop {
        if start.elapsed() > timeout {
            return Err("Timeout waiting for response".into());
        }
        match port.read(&mut buf) {
            Ok(n) if n > 0 => {
                result.push(buf[0]);
                if result.ends_with(target) {
                    return Ok(result);
                }
            }
            Ok(_) => {},
            Err(ref e) if e.kind() == io::ErrorKind::TimedOut => {},
            Err(e) => return Err(e.to_string()),
        }
    }
}

fn enter_raw_repl(port: &mut dyn SerialPort) -> Result<(), String> {
    // Ctrl-C to interrupt
    port.write_all(&[0x03]).map_err(|e| e.to_string())?;
    port.write_all(&[0x03]).map_err(|e| e.to_string())?;
    thread::sleep(Duration::from_millis(100));
    
    // Ctrl-A to enter raw REPL
    port.write_all(&[0x01]).map_err(|e| e.to_string())?;
    
    // Expect "raw REPL; CTRL-B to exit\r\n>"
    read_until(port, b"raw REPL; CTRL-B to exit", Duration::from_secs(2))?;
    read_until(port, b">", Duration::from_secs(1))?;
    
    Ok(())
}

fn exec_raw(port: &mut dyn SerialPort, code: &[u8]) -> Result<Vec<u8>, String> {
    // Write code
    // Increased chunk size and reduced sleep for speed
    for chunk in code.chunks(256) {
        port.write_all(chunk).map_err(|e| e.to_string())?;
        thread::sleep(Duration::from_millis(1));
    }
    
    // Ctrl-D to execute
    port.write_all(&[0x04]).map_err(|e| e.to_string())?;
    
    // Wait for "OK"
    let resp = read_until(port, b"\x04>", Duration::from_secs(10))?;
    
    // Check for OK
    if let Some(idx) = resp.windows(2).position(|w| w == b"OK") {
        // Return output after OK
        Ok(resp[idx+2 .. resp.len()-2].to_vec())
    } else {
        Err("Execution failed (no OK)".into())
    }
}

fn create_parent_dirs(port: &mut dyn SerialPort, path: &str) -> Result<(), String> {
    let parts: Vec<&str> = path.split('/').collect();
    if parts.len() <= 2 { return Ok(()); }
    
    let mut current_path = String::new();
    for part in &parts[1..parts.len()-1] {
        current_path.push('/');
        current_path.push_str(part);
        let code = format!("import os\ntry:\n os.mkdir('{}')\nexcept:\n pass", current_path);
        exec_raw(port, code.as_bytes())?;
    }
    Ok(())
}

fn upload_file(port: &mut dyn SerialPort, filename: &str, content: &[u8]) -> Result<(), String> {
    create_parent_dirs(port, filename)?;

    // Import ubinascii for base64 decoding
    exec_raw(port, b"import ubinascii")?;

    // f=open('filename','wb');w=f.write
    let cmd = format!("f=open('{}','wb');w=f.write", filename);
    exec_raw(port, cmd.as_bytes())?;
    
    // Write chunks using base64
    for chunk in content.chunks(1024) {
        let b64 = BASE64_STANDARD.encode(chunk);
        let cmd = format!("w(ubinascii.a2b_base64('{}'))", b64);
        exec_raw(port, cmd.as_bytes())?;
    }
    
    // f.close()
    exec_raw(port, b"f.close()")?;
    
    Ok(())
}

fn soft_reset(port: &mut dyn SerialPort) -> Result<(), String> {
    // Ctrl-D in raw REPL does soft reset
    port.write_all(&[0x04]).map_err(|e| e.to_string())?;
    Ok(())
}
