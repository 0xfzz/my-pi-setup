// Shared canvas primitives and fast math for ascii-anim-engine

pub const MAX_COLS: usize = 128;
pub const MAX_ROWS: usize = 64;
pub const MAX_BUFFER: usize = 16384;

#[derive(Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum ColorToken {
    Text = 0,
    Dim = 1,
    Muted = 2,
    Accent = 3,
    Warning = 4,
    Success = 5,
    Error = 6,
}

#[derive(Clone, Copy)]
pub struct Cell {
    pub ch: char,
    pub color: ColorToken,
}

impl Default for Cell {
    fn default() -> Self {
        Self { ch: ' ', color: ColorToken::Text }
    }
}

pub struct Canvas {
    pub grid: [[Cell; MAX_COLS]; MAX_ROWS],
    pub cols: usize,
    pub rows: usize,
}

impl Canvas {
    pub const fn new() -> Self {
        Self {
            grid: [[Cell { ch: ' ', color: ColorToken::Text }; MAX_COLS]; MAX_ROWS],
            cols: 0,
            rows: 0,
        }
    }

    pub fn reset(&mut self, cols: usize, rows: usize) {
        self.cols = cols.clamp(12, MAX_COLS);
        self.rows = rows.clamp(6, MAX_ROWS);
        for r in 0..self.rows {
            for c in 0..self.cols {
                self.grid[r][c] = Cell::default();
            }
        }
    }

    pub fn put(&mut self, r: usize, c: i32, text: &str, color: ColorToken) {
        if r == 0 || r >= self.rows - 1 { return; }
        for (i, ch) in text.chars().enumerate() {
            if ch == ' ' { continue; }
            let col = c + i as i32;
            if col > 0 && (col as usize) < self.cols - 1 {
                self.grid[r][col as usize] = Cell { ch, color };
            }
        }
    }

    pub fn draw_box_border(&mut self) {
        let cols = self.cols;
        let rows = self.rows;
        self.grid[0][0] = Cell { ch: '┌', color: ColorToken::Dim };
        for c in 1..cols - 1 {
            self.grid[0][c] = Cell { ch: '─', color: ColorToken::Dim };
            self.grid[rows - 1][c] = Cell { ch: '─', color: ColorToken::Dim };
        }
        self.grid[0][cols - 1] = Cell { ch: '┐', color: ColorToken::Dim };
        self.grid[rows - 1][0] = Cell { ch: '└', color: ColorToken::Dim };
        self.grid[rows - 1][cols - 1] = Cell { ch: '┘', color: ColorToken::Dim };

        for r in 1..rows - 1 {
            self.grid[r][0] = Cell { ch: '│', color: ColorToken::Dim };
            self.grid[r][cols - 1] = Cell { ch: '│', color: ColorToken::Dim };
        }
    }

    pub fn serialize(&self, buffer: &mut [u8], use_ansi: bool) -> usize {
        let mut idx = 0;
        for r in 0..self.rows {
            if r > 0 && idx < MAX_BUFFER {
                buffer[idx] = b'\n';
                idx += 1;
            }

            let mut current_token = ColorToken::Text;
            for c in 0..self.cols {
                let cell = self.grid[r][c];
                if use_ansi && cell.color != current_token {
                    let escape: &[u8] = match cell.color {
                        ColorToken::Dim => b"\x1b[2m",
                        ColorToken::Muted => b"\x1b[38;5;244m",
                        ColorToken::Accent => b"\x1b[36;1m",
                        ColorToken::Warning => b"\x1b[33;1m",
                        ColorToken::Success => b"\x1b[32m",
                        ColorToken::Error => b"\x1b[31;1m",
                        ColorToken::Text => b"\x1b[0m",
                    };
                    if idx + escape.len() < MAX_BUFFER {
                        buffer[idx..idx + escape.len()].copy_from_slice(escape);
                        idx += escape.len();
                    }
                    current_token = cell.color;
                }

                let mut buf = [0u8; 4];
                let encoded = cell.ch.encode_utf8(&mut buf);
                if idx + encoded.len() < MAX_BUFFER {
                    buffer[idx..idx + encoded.len()].copy_from_slice(encoded.as_bytes());
                    idx += encoded.len();
                }
            }

            if use_ansi && current_token != ColorToken::Text {
                let reset = b"\x1b[0m";
                if idx + reset.len() < MAX_BUFFER {
                    buffer[idx..idx + reset.len()].copy_from_slice(reset);
                    idx += reset.len();
                }
            }
        }
        idx
    }
}

pub fn hash(a: u32, b: u32) -> f32 {
    let mut h = a.wrapping_mul(0x27d4eb2d) ^ b.wrapping_mul(0x165667b1);
    h = (h ^ (h >> 15)).wrapping_mul(0x85ebca6b);
    h = (h ^ (h >> 13)).wrapping_mul(0xc2b2ae35);
    let val = (h ^ (h >> 16)) as f64;
    (val / 4294967296.0) as f32
}

pub fn sin(x: f32) -> f32 {
    let pi = core::f32::consts::PI;
    let tau = core::f32::consts::TAU;
    let mut v = x % tau;
    if v < 0.0 { v += tau; }
    if v > pi { v -= tau; }
    if v > pi / 2.0 { v = pi - v; }
    else if v < -pi / 2.0 { v = -pi - v; }
    let v2 = v * v;
    v * (1.0 - v2 * (1.0 / 6.0 - v2 * (1.0 / 120.0 - v2 / 5040.0)))
}

pub fn cos(x: f32) -> f32 {
    sin(x + core::f32::consts::FRAC_PI_2)
}

#[inline]
pub fn round(x: f32) -> f32 {
    if x >= 0.0 {
        (x + 0.5) as i32 as f32
    } else {
        (x - 0.5) as i32 as f32
    }
}
