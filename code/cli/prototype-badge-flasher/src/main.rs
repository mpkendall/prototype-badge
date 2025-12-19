use std::error::Error;
use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Arc, atomic::{AtomicBool, Ordering}};
use std::thread;
use std::time::Duration;

use crossterm::event::{self, Event as CEvent, KeyCode, KeyEventKind};
use crossterm::execute;
use crossterm::terminal::{disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen};
use ratatui::backend::CrosstermBackend;
use ratatui::layout::{Constraint, Direction, Layout, Alignment};
use ratatui::style::{Color, Modifier, Style};
use ratatui::widgets::{Block, Borders, List, ListItem, Paragraph, Wrap, Tabs};
use ratatui::{Terminal, Frame};
use ratatui::widgets::ListState;

mod serial_tab;
use serial_tab::SerialTab;

#[derive(Clone, Debug)]
struct Device {
	root: PathBuf,
	label: String,
}

enum ProgressMsg {
	Progress(u64, u64), // written, total
	Done,
	Err(String),
	Cancelled,
}

#[derive(PartialEq, Debug)]
enum FlashState {
	Idle,
	Flashing,
	Success,
	Failed(String),
	Cancelled,
}

#[derive(PartialEq)]
enum Tab {
    Uf2Flasher,
    SerialUpdate,
}

struct App {
    current_tab: Tab,
    serial_tab: SerialTab,
	devices: Vec<Device>,
	selected: usize,
	uf2_path: Option<PathBuf>,
	input_mode: bool,
	input_buffer: String,
	flash_state: FlashState,
	progress: f64,
	progress_written: u64,
	progress_total: u64,
	logs: Vec<String>,
	progress_rx: Option<mpsc::Receiver<ProgressMsg>>,
	cancel_flag: Option<Arc<AtomicBool>>,
	log_file: Option<File>,
}

impl App {
	fn new() -> Self {
		// At build time, check for a bundled UF2 in the crate directory and use it if present
		let bundled = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("RPI_PICO-20250415-v1.25.0.uf2");
		let uf2 = if bundled.exists() && bundled.is_file() { Some(bundled) } else { None };

		let log_file = std::fs::OpenOptions::new()
			.create(true)
			.append(true)
			.open("flasher.log")
			.ok();

		Self {
            current_tab: Tab::Uf2Flasher,
            serial_tab: SerialTab::new(),
			devices: Vec::new(),
			selected: 0,
			uf2_path: uf2,
			input_mode: false,
			input_buffer: String::new(),
			flash_state: FlashState::Idle,
			progress: 0.0,
			progress_written: 0,
			progress_total: 0,
			logs: Vec::new(),
			progress_rx: None,
			cancel_flag: None,
			log_file,
		}
	}

	fn log(&mut self, s: impl Into<String>) {
		let s = s.into();
		// Write to file if available
		if let Some(f) = &mut self.log_file {
			// We ignore errors here to avoid crashing or recursive logging issues
			let _ = writeln!(f, "{}", s);
		}
		
		self.logs.push(s);
		if self.logs.len() > 100 {
			self.logs.drain(..self.logs.len() - 100);
		}
	}
}

fn main() -> Result<(), Box<dyn Error>> {
	color_eyre::install()?;

	run_app()
}

fn run_app() -> Result<(), Box<dyn Error>> {
	enable_raw_mode()?;
	let mut stdout = io::stdout();
	execute!(stdout, EnterAlternateScreen)?;

	let backend = CrosstermBackend::new(stdout);
	let mut terminal = Terminal::new(backend)?;

	let mut app = App::new();
	app.log("Starting UI");
    app.serial_tab.init();
	scan_devices(&mut app);
	if let Some(p) = &app.uf2_path {
		app.log(format!("Using bundled UF2 by default: {}", p.display()));
	}

	let res = run_loop(&mut terminal, app);

	// Restore terminal
	disable_raw_mode()?;
	execute!(terminal.backend_mut(), LeaveAlternateScreen)?;
	terminal.show_cursor()?;

	res
}

/// look for mounts that contain "INFO_UF2.TXT"
fn scan_devices(app: &mut App) {
	app.devices.clear();

	#[cfg(windows)]
	{
		for c in b'A'..=b'Z' {
			let drive = format!("{}:\\", c as char);
			let root = PathBuf::from(&drive);
			if root.exists() {
				let info = root.join("INFO_UF2.TXT");
				if info.exists() {
					let label = fs::read_to_string(&info).unwrap_or_else(|_| "RP2040".into());
					app.devices.push(Device { root, label: label.lines().next().unwrap_or("RP2040").to_string() });
				}
			}
		}
	}

	#[cfg(not(windows))]
	{
		let mut roots = Vec::new();
		for candidate in ["/media", "/mnt", "/Volumes", "/run/media"].iter() {
			let p = Path::new(candidate);
			if p.exists() {
				if p.is_dir() {
					for entry in p.read_dir().into_iter().flatten() {
						let path = entry.path();
						// on Linux /run/media/$USER/<label>
						if path.is_dir() {
							roots.push(path);
						}
					}
				}
			}
		}

		for root in roots {
			let info = root.join("INFO_UF2.TXT");
			if info.exists() {
				let label = fs::read_to_string(&info).unwrap_or_else(|_| "RP2040".into());
				app.devices.push(Device { root, label: label.lines().next().unwrap_or("RP2040").to_string() });
			}
		}
	}

	if app.devices.is_empty() {
		app.log("No RP2040 bootloader devices found. Plug the board and press 'r' to rescan.");
	} else {
		app.log(format!("Found {} device(s)", app.devices.len()));
	}
}

fn run_loop<B: ratatui::backend::Backend>(terminal: &mut Terminal<B>, mut app: App) -> Result<(), Box<dyn Error>> {
	loop {
        // Update serial tab
        app.serial_tab.update();

	if let Some(rx) = &app.progress_rx {
		let mut msgs = Vec::new();
		while let Ok(msg) = rx.try_recv() {
			msgs.push(msg);
		}
		for msg in msgs {
			match msg {
				ProgressMsg::Progress(written, total) => {
					app.progress_written = written;
					app.progress_total = total;
					app.progress = written as f64 / total.max(1) as f64;
				}
				ProgressMsg::Done => {
					app.progress = 1.0;
					app.flash_state = FlashState::Success;
					app.log("Flash completed successfully");
					app.progress_rx = None;
					app.cancel_flag = None;
					break;
				}
				ProgressMsg::Err(e) => {
					app.flash_state = FlashState::Failed(e.clone());
					app.log(format!("Flash failed: {}", e));
					app.progress_rx = None;
					app.cancel_flag = None;
					break;
				}
				ProgressMsg::Cancelled => {
					app.flash_state = FlashState::Cancelled;
					app.log("Flash cancelled");
					app.progress_rx = None;
					app.cancel_flag = None;
					break;
					}
				}
			}
		}

		terminal.draw(|f| {
			let size = f.area();

			let outer = Block::default()
				.borders(Borders::ALL)
				.title("RP2040 Flasher — Minimal TUI")
				.style(Style::default().fg(Color::White));
			f.render_widget(outer, size);

            let main_layout = Layout::default()
                .direction(Direction::Vertical)
                .constraints([Constraint::Length(3), Constraint::Min(0)].as_ref())
                .split(size.inner(ratatui::layout::Margin { vertical: 1, horizontal: 1 }));

            // Tabs
            let titles = vec!["UF2 Flasher", "Serial Update"];
            let tabs = Tabs::new(titles)
                .block(Block::default().borders(Borders::ALL).title("Mode"))
                .highlight_style(Style::default().fg(Color::Yellow))
                .select(match app.current_tab { Tab::Uf2Flasher => 0, Tab::SerialUpdate => 1 });
            f.render_widget(tabs, main_layout[0]);

            match app.current_tab {
                Tab::Uf2Flasher => render_uf2_tab(f, &mut app, main_layout[1]),
                Tab::SerialUpdate => app.serial_tab.render(f, main_layout[1]),
            }
		})?;

		// innput handling
		if event::poll(Duration::from_millis(150))? {
			if let CEvent::Key(key) = event::read()? {
				// ignore non-press events to avoid duplicate keystrokes
				if key.kind != KeyEventKind::Press { continue; }

                // Global tab switching
                match key.code {
                    KeyCode::Tab => {
                        app.current_tab = match app.current_tab {
                            Tab::Uf2Flasher => Tab::SerialUpdate,
                            Tab::SerialUpdate => Tab::Uf2Flasher,
                        };
                        continue;
                    }
                    KeyCode::Char('q') | KeyCode::Esc => break,
                    _ => {}
                }

                match app.current_tab {
                    Tab::SerialUpdate => app.serial_tab.handle_input(key.code),
                    Tab::Uf2Flasher => handle_uf2_input(&mut app, key.code),
                }
			}
		}
	}

	Ok(())
}

fn render_uf2_tab(f: &mut Frame, app: &mut App, area: ratatui::layout::Rect) {
			let chunks = Layout::default()
				.direction(Direction::Vertical)
			.constraints([Constraint::Length(3), Constraint::Min(0), Constraint::Length(6)].as_ref())
				.split(area);
			let header = Paragraph::new("Press 'r' to rescan devices • 'e' to edit UF2 path • 'f' to flash • 'q' to quit")
				.wrap(Wrap { trim: true });
			f.render_widget(header, chunks[0]);

		let main_chunks = Layout::default()
			.direction(Direction::Horizontal)
			.constraints([Constraint::Percentage(40), Constraint::Percentage(60)].as_ref())
			.split(chunks[1]);

			let mut items: Vec<ListItem> = Vec::new();
			for d in &app.devices {
				items.push(ListItem::new(format!("{} — {}", d.root.display(), d.label)));
			}
			if items.is_empty() {
				items.push(ListItem::new("(no devices detected)"));
			}
			let devices_list = List::new(items)
				.block(Block::default().borders(Borders::ALL).title("Devices"))
				.highlight_style(Style::default().add_modifier(Modifier::BOLD))
				.highlight_symbol("➤ ");
			let mut state = ListState::default();
			if !app.devices.is_empty() { state.select(Some(app.selected)); }
			f.render_stateful_widget(devices_list, main_chunks[0], &mut state);

			let uf2_text = match &app.uf2_path {
				Some(p) => format!("UF2: {}", p.display()),
				None => format!("UF2: <not selected> — press 'e' to enter path"),
			};

			let mut right = String::new();
			right.push_str(&uf2_text);
			right.push_str("\n\n");
			right.push_str(&format!("Flash state: {:?}\n", app.flash_state));
			if app.progress_total > 0 {
			right.push_str(&format!("Progress: {:.1}% ({}/{})\n", app.progress * 100.0, app.progress_written, app.progress_total));
		} else {
			right.push_str(&format!("Progress: {:.1}%\n", app.progress * 100.0));
		}


			let details = Paragraph::new(right.as_str()).block(Block::default().borders(Borders::ALL).title("Details"));
			f.render_widget(details, main_chunks[1]);

		// Logs area (fixed height)
		let log_height = chunks[2].height.saturating_sub(2) as usize;
		let mut logs_items: Vec<ListItem> = Vec::new();
		let mut last_logs: Vec<String> = app.logs.iter().rev().take(log_height).cloned().collect();
		last_logs.reverse();
		if last_logs.is_empty() {
			logs_items.push(ListItem::new("<no logs>"));
		} else {
			for l in last_logs {
				logs_items.push(ListItem::new(l));
			}
		}
		let logs_list = List::new(logs_items).block(Block::default().borders(Borders::ALL).title("Logs"));
		f.render_widget(logs_list, chunks[2]);
		if app.input_mode {
			let area = centered_rect(60, 20, area);
			let input = Paragraph::new(app.input_buffer.as_str())
				.block(Block::default().borders(Borders::ALL).title("Enter UF2 path (Enter to confirm, Esc to cancel)"));
			f.render_widget(input, area);
		}

			if app.flash_state == FlashState::Flashing {
				// increase popup vertical size to make the progress more visible
				let gauge_area = centered_rect(50, 18, area);
				let ratio = if app.progress_total > 0 { app.progress_written as f64 / app.progress_total as f64 } else { app.progress.clamp(0.0, 1.0) };
				let label = if app.progress_total > 0 {
					format!("{:.1}% ({}/{})", ratio * 100.0, app.progress_written, app.progress_total)
				} else {
					format!("{:.1}%", ratio * 100.0)
				};
				// Build an ASCII/Unicode bar inside the popup to avoid depending on Gauge rendering
				let total_w = gauge_area.width as usize;
				let reserved = 6usize; // borders/spacing and room for label
				let max_bar_space = total_w.saturating_sub(reserved);
				let label_len = label.chars().count();
				let bar_space = if max_bar_space > label_len + 1 { max_bar_space - (label_len + 1) } else { 0 };
				let bar_width = bar_space.min(40);
				let bar_str = if bar_width > 0 {
					let mut filled = ((bar_width as f64) * ratio).floor() as usize;
					if ratio > 0.0 && filled == 0 { filled = 1; } // ensure we show some progress once started
					if filled > bar_width { filled = bar_width; }
					let empty = bar_width - filled;
					let filled_str = "█".repeat(filled);
					let empty_str = "░".repeat(empty);
					format!("{}{}", filled_str, empty_str)
				} else {
					// too narrow for a full bar, show a small indicator if progress started
					if ratio > 0.0 && ratio < 1.0 { ">".to_string() } else if ratio >= 1.0 { "█".to_string() } else { String::new() }
				};
				let display = if bar_str.is_empty() {
					label.clone()
				} else if gauge_area.height >= 5 {
					// multi-line rendering when there is vertical space
					format!("{}\n\n{}", bar_str, label)
				} else {
					format!("{} {}", bar_str, label)
				};
				let p = Paragraph::new(display)
					.block(Block::default().borders(Borders::ALL).title("Flashing..."))
					.alignment(Alignment::Center)
					.style(Style::default().fg(Color::Green));
				f.render_widget(p, gauge_area);
			}
}

fn handle_uf2_input(app: &mut App, code: KeyCode) {
				// typing a path
				if app.input_mode {
					match code {
						KeyCode::Enter => {
							let trimmed = app.input_buffer.trim();
							if !trimmed.is_empty() {
								let p = PathBuf::from(trimmed);
								if p.exists() && p.is_file() {
									app.uf2_path = Some(p.clone());
									 app.log(format!("UF2 path set to {}", p.display()));
								} else {
									 app.log("Selected path doesn't exist or is not a file");
								}
							}
							app.input_mode = false;
							app.input_buffer.clear();
						}
						KeyCode::Esc => {
							app.input_mode = false;
							app.input_buffer.clear();
						}
						KeyCode::Backspace => { app.input_buffer.pop(); }
						KeyCode::Char(c) => { app.input_buffer.push(c); }
						_ => {}
					}
					return;
				}

				match code {
					KeyCode::Char('r') => {
						scan_devices(app);
					}
					KeyCode::Char('j') | KeyCode::Down => {
						if !app.devices.is_empty() { app.selected = (app.selected + 1) % app.devices.len(); }
					}
					KeyCode::Char('k') | KeyCode::Up => {
						if !app.devices.is_empty() { app.selected = (app.selected + app.devices.len() - 1) % app.devices.len(); }
					}
					KeyCode::Char('e') | KeyCode::Char('p') => {
						app.input_mode = true;
						if let Some(p) = &app.uf2_path { app.input_buffer = p.display().to_string(); }
					}
					KeyCode::Char('f') => {
						if app.flash_state == FlashState::Flashing {
							app.log("Already flashing");
						} else if app.devices.is_empty() {
							app.log("No device selected");
						} else if app.uf2_path.is_none() {
							app.log("No UF2 selected — press 'e' to enter a path");
						} else {
							// start flashing
							let dev = app.devices[app.selected].clone();
							let src = app.uf2_path.clone().unwrap();
							match start_flash_worker(&dev.root, &src) {
								Ok((rx, cancel_flag)) => {
									app.progress_rx = Some(rx);
									app.cancel_flag = Some(cancel_flag);
									app.flash_state = FlashState::Flashing;
									app.progress = 0.0;
									app.log(format!("Started flashing {} -> {}", src.display(), dev.root.display()));
								}
								Err(e) => {
									app.log(format!("Failed to start flash: {}", e));
								}
							}
						}
					}
					KeyCode::Char('c') => {
						if let Some(flag) = &app.cancel_flag {
							flag.store(true, Ordering::SeqCst);
						}
					}
					_ => {}
				}
}

fn start_flash_worker(dst_root: &Path, src: &Path) -> Result<(mpsc::Receiver<ProgressMsg>, Arc<AtomicBool>), Box<dyn Error>> {
	if !src.exists() || !src.is_file() {
		return Err(format!("Source file doesn't exist: {}", src.display()).into());
	}

	let filename = src.file_name().ok_or_else(|| "Invalid source filename" )?.to_owned();
	let dst = dst_root.join(filename);
	let src = src.to_owned();

	let (tx, rx) = mpsc::channel();
	let cancel_flag = Arc::new(AtomicBool::new(false));
	let cf = cancel_flag.clone();

	thread::spawn(move || {
		if let Err(e) = do_copy(&src, &dst, &tx, &cf) {
			let _ = tx.send(ProgressMsg::Err(e));
		}
	});

	Ok((rx, cancel_flag))
}

fn do_copy(src: &Path, dst: &Path, tx: &mpsc::Sender<ProgressMsg>, cancel_flag: &Arc<AtomicBool>) -> Result<(), String> {
	let mut infile = File::open(src).map_err(|e| e.to_string())?;
	let total = infile.metadata().map_err(|e| e.to_string())?.len();

	let mut outfile = File::create(dst).map_err(|e| e.to_string())?;

	let mut buf = [0u8; 8192];
	let mut written: u64 = 0;
	loop {
		if cancel_flag.load(Ordering::SeqCst) {
			let _ = tx.send(ProgressMsg::Cancelled);
			// best-effort: remove partial file
			let _ = fs::remove_file(dst);
			return Ok(());
		}
		let n = infile.read(&mut buf).map_err(|e| e.to_string())?;
		if n == 0 { break; }
		outfile.write_all(&buf[..n]).map_err(|e| e.to_string())?;
		written += n as u64;
		let _ = tx.send(ProgressMsg::Progress(written, total));
	}

	// writing the UF2 file triggers the device to reboot
	outfile.sync_all().map_err(|e| e.to_string())?;

	let _ = tx.send(ProgressMsg::Done);
	Ok(())
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

