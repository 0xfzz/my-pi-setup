use crate::canvas::{Canvas, Cell, ColorToken, hash, round, sin};

pub fn render(canvas: &mut Canvas, seconds: f32) {
    let cols = canvas.cols;
    let rows = canvas.rows;
    canvas.draw_box_border();

    let floor = rows - 2;
    let center_x = (cols as i32) / 2;
    let half_width = ((cols as i32) / 3).clamp(4, 16);

    // 1. Fire hearth base / logs
    let hearth_y = floor;
    for c in (center_x - half_width)..(center_x + half_width) {
        if c > 0 && (c as usize) < cols - 1 {
            let log_ch = if (c % 2) == 0 { '=' } else { '#' };
            canvas.grid[hearth_y][c as usize] = Cell { ch: log_ch, color: ColorToken::Warning };
        }
    }

    // 2. Coals above logs
    if hearth_y >= 2 {
        let coal_y = hearth_y - 1;
        for c in (center_x - half_width + 1)..(center_x + half_width - 1) {
            if c > 0 && (c as usize) < cols - 1 {
                let n = hash(c as u32, (seconds * 8.0) as u32);
                let coal_ch = if n < 0.3 { '#' } else if n < 0.6 { ')' } else { '(' };
                canvas.grid[coal_y][c as usize] = Cell { ch: coal_ch, color: ColorToken::Error };
            }
        }
    }

    // 3. Flame simulation
    let flame_height = (rows - 4).clamp(2, 10);
    for h in 1..=flame_height {
        let r = (floor as i32) - 1 - (h as i32);
        if r <= 1 { break; }

        let h_frac = h as f32 / flame_height as f32;
        let span = round((1.0 - h_frac * 0.7) * (half_width as f32)) as i32;

        for c in (center_x - span)..(center_x + span) {
            if c <= 0 || (c as usize) >= cols - 1 { continue; }

            let offset = (c - center_x) as f32;
            let flicker = sin(seconds * 12.0 + offset * 0.8 + (h as f32) * 1.5);
            let noise = hash(c as u32 + (h as u32) * 13, (seconds * 10.0) as u32);

            if flicker + noise > 0.4 {
                let glyph = if h_frac > 0.7 {
                    if noise < 0.5 { '·' } else { '^' }
                } else if h_frac > 0.4 {
                    if noise < 0.4 { ')' } else if noise < 0.7 { '(' } else { '^' }
                } else {
                    if noise < 0.35 { '*' } else if noise < 0.7 { '~' } else { '#' }
                };

                let color = if h_frac > 0.65 {
                    if noise < 0.3 { ColorToken::Text } else { ColorToken::Warning }
                } else if h_frac > 0.35 {
                    ColorToken::Warning
                } else {
                    ColorToken::Error
                };

                canvas.grid[r as usize][c as usize] = Cell { ch: glyph, color };
            }
        }
    }

    // 4. Floating embers rising into the air
    let num_embers = 4;
    for k in 0..num_embers {
        let age = (seconds * 2.5 + k as f32 * 2.1) % 6.0;
        let progress = age / 6.0;
        let ember_r = (floor as i32 - 2 - round(progress * (rows as f32 - 4.0)) as i32).clamp(2, (floor as i32) - 1) as usize;
        let wobble = round(sin(age * 3.0 + k as f32) * 2.5) as i32;
        let ember_c = center_x + wobble;
        if ember_r > 1 && ember_r < rows - 1 && ember_c > 0 && (ember_c as usize) < cols - 1 {
            canvas.grid[ember_r][ember_c as usize] = Cell { ch: '·', color: ColorToken::Text };
        }
    }
}
