use crate::canvas::{Canvas, Cell, ColorToken, cos, hash, round, sin};

pub fn render(canvas: &mut Canvas, seconds: f32) {
    let cols = canvas.cols;
    let rows = canvas.rows;
    let floor = rows - 2;
    let water_depth = if floor >= 2 { floor - 2 } else { 0 };

    let loop_time = 48.0;
    let mut u = seconds % loop_time;
    if u < 0.0 { u += loop_time; }

    // 1. Tank Glass Borders
    canvas.draw_box_border();

    // 2. Water Surface Ripples (aquatic blue)
    for c in 1..cols - 1 {
        let wave = sin(c as f32 * 0.45 - u * 2.8) + 0.4 * sin(c as f32 * 0.85 + u * 1.9);
        let glyph = if wave > 0.35 { '~' } else if wave < -0.35 { '^' } else { '-' };
        canvas.grid[1][c] = Cell { ch: glyph, color: ColorToken::Accent };
    }

    // 3. Sandy Gravel Bed
    for c in 1..cols - 1 {
        let n = hash((c - 1) as u32, 7);
        let (ch, color) = if n < 0.12 { ('o', ColorToken::Muted) }
        else if n < 0.22 { ('°', ColorToken::Dim) }
        else if n < 0.35 { ('.', ColorToken::Dim) }
        else if n < 0.50 { ('·', ColorToken::Dim) }
        else if n < 0.62 { (',', ColorToken::Dim) }
        else { (' ', ColorToken::Dim) };
        canvas.grid[floor][c] = Cell { ch, color };
    }

    // 4. Bubble Stone & Air Bubbles
    let stone_col = (cols as i32) - 5;
    if stone_col > 8 {
        canvas.put(floor, stone_col, "._.", ColorToken::Dim);
        let bubble_count = if cols < 26 { 3 } else { 4 };
        let bubble_cycle = 5.0f32;
        for k in 0..bubble_count {
            let bubble_age = (u + (k as f32) * (bubble_cycle / bubble_count as f32)) % bubble_cycle;
            let progress = bubble_age / bubble_cycle;
            let bubble_row = round((floor as f32 - 1.0) - progress * ((floor as f32) - 2.5)) as usize;
            let wobble = sin(bubble_age * 3.8 + k as f32) * 0.7;
            let bubble_c = stone_col + 1 + (round(wobble) as i32);
            if bubble_row >= 2 && bubble_row < floor && bubble_c > 0 && (bubble_c as usize) < cols - 1 {
                let glyph = if progress < 0.25 { "·" } else if progress < 0.6 { "." } else if progress < 0.88 { "o" } else { "°" };
                let color = if progress >= 0.88 { ColorToken::Text } else { ColorToken::Accent };
                canvas.put(bubble_row, bubble_c, glyph, color);
            }
        }
    }

    // 5. Swaying Kelp / Seaweed
    let roots: &[(i32, usize, f32)] = if cols >= 42 {
        &[(2, water_depth.min(5).max(3), 0.0), (stone_col + 1, (water_depth.saturating_sub(1)).min(4).max(2), 1.8), ((cols as i32) * 4 / 10, water_depth.min(4), 0.9)]
    } else {
        &[(2, water_depth.min(5).max(3), 0.0), (stone_col + 1, (water_depth.saturating_sub(1)).min(4).max(2), 1.8)]
    };

    for &(root_col, height, phase) in roots.iter() {
        if root_col <= 0 || (root_col as usize) >= cols - 1 { continue; }
        for k in 1..=height {
            if k >= floor { break; }
            let r = floor - k;
            if r <= 1 { break; }
            let sway = sin(u * 1.5 + phase + (k as f32) * 0.4) * (k as f32 / height as f32) * 1.1;
            let weed_c = root_col + (round(sway) as i32);
            let glyph = if sway > 0.35 { ")" } else if sway < -0.35 { "(" } else { "|" };
            canvas.put(r, weed_c, glyph, ColorToken::Success);
        }
    }

    // Helper for multi-harmonic wandering movement (exact period loop_time = 48.0)
    let wander_1d = |seed: f32| -> (f32, f32) {
        let w = 2.0 * core::f32::consts::PI / loop_time;
        let p1 = (seed * 1.61803) % (2.0 * core::f32::consts::PI);
        let p2 = (seed * 2.71828) % (2.0 * core::f32::consts::PI);
        let p3 = (seed * 3.14159) % (2.0 * core::f32::consts::PI);
        let p4 = (seed * 4.66920) % (2.0 * core::f32::consts::PI);

        let pos = 0.5
            + 0.28 * sin(1.0 * w * u + p1)
            + 0.14 * sin(2.0 * w * u + p2)
            + 0.06 * sin(3.0 * w * u + p3)
            + 0.03 * sin(5.0 * w * u + p4);

        let vel = 0.28 * 1.0 * w * cos(1.0 * w * u + p1)
            + 0.14 * 2.0 * w * cos(2.0 * w * u + p2)
            + 0.06 * 3.0 * w * cos(3.0 * w * u + p3)
            + 0.03 * 5.0 * w * cos(5.0 * w * u + p4);

        (pos.clamp(0.0, 1.0), vel)
    };

    let wander_depth = |seed: f32| -> f32 {
        let w = 2.0 * core::f32::consts::PI / loop_time;
        let p1 = (seed * 1.73205) % (2.0 * core::f32::consts::PI);
        let p2 = (seed * 3.41421) % (2.0 * core::f32::consts::PI);
        (0.5 + 0.35 * sin(2.0 * w * u + p1) + 0.15 * sin(4.0 * w * u + p2)).clamp(0.0, 1.0)
    };

    // 6. Creature 1: Neon Tetra (cyan body, red tailfin, white eye)
    {
        let min_x = 3i32;
        let max_x = (min_x + 2).max((cols as i32) - 10);
        let (w_pos, w_vel) = wander_1d(11.0);
        let x = round(min_x as f32 + w_pos * (max_x - min_x) as f32) as i32;
        let facing = if w_vel > 0.003 { "right" } else if w_vel < -0.003 { "left" } else { "turn" };
        let min_y = 2i32;
        let max_y = (min_y).max((floor as i32) - 1);
        let y_pos = wander_depth(29.0);
        let mid_row = round(min_y as f32 + y_pos * (max_y - min_y) as f32) as usize;
        let hunger = 0.5 + 0.45 * sin(u * (2.0 * core::f32::consts::PI / 24.0) + 1.2);
        let eye = if hunger >= 0.70 { "O" } else if hunger >= 0.35 { "o" } else { "°" };
        match facing {
            "right" => {
                canvas.put(mid_row, x, "><", ColorToken::Error);
                canvas.put(mid_row, x + 2, "(((", ColorToken::Accent);
                canvas.put(mid_row, x + 5, eye, ColorToken::Text);
                canvas.put(mid_row, x + 6, ">", ColorToken::Accent);
            }
            "left" => {
                canvas.put(mid_row, x, "<", ColorToken::Accent);
                canvas.put(mid_row, x + 1, eye, ColorToken::Text);
                canvas.put(mid_row, x + 2, ")))", ColorToken::Accent);
                canvas.put(mid_row, x + 5, "><", ColorToken::Error);
            }
            _ => {
                canvas.put(mid_row, x, "<(", ColorToken::Accent);
                canvas.put(mid_row, x + 2, eye, ColorToken::Text);
                canvas.put(mid_row, x + 3, "o", ColorToken::Text);
                canvas.put(mid_row, x + 4, eye, ColorToken::Text);
                canvas.put(mid_row, x + 5, ")>", ColorToken::Accent);
            }
        }
    }

    // 7. Creature 2: Small Golden Minnow
    if water_depth >= 3 && cols >= 22 {
        let min_x = 4i32;
        let max_x = (min_x + 2).max((cols as i32) - 7);
        let (w_pos, w_vel) = wander_1d(47.0);
        let x = round(min_x as f32 + w_pos * (max_x - min_x) as f32) as i32;
        let facing = if w_vel > 0.003 { "right" } else if w_vel < -0.003 { "left" } else { "turn" };
        let min_y = 2i32;
        let max_y = (min_y).max((floor as i32) - 2);
        let y_pos = wander_depth(71.0);
        let top_row = round(min_y as f32 + y_pos * (max_y - min_y) as f32) as usize;
        let hunger = 0.5 + 0.45 * sin(u * (2.0 * core::f32::consts::PI / 18.0) + 3.4);
        let eye = if hunger >= 0.70 { "O" } else if hunger >= 0.35 { "*" } else { "'" };
        match facing {
            "right" => {
                canvas.put(top_row, x, "><", ColorToken::Warning);
                canvas.put(top_row, x + 2, eye, ColorToken::Text);
                canvas.put(top_row, x + 3, ">", ColorToken::Warning);
            }
            "left" => {
                canvas.put(top_row, x, "<", ColorToken::Warning);
                canvas.put(top_row, x + 1, eye, ColorToken::Text);
                canvas.put(top_row, x + 2, "><", ColorToken::Warning);
            }
            _ => {
                canvas.put(top_row, x, "<", ColorToken::Warning);
                canvas.put(top_row, x + 1, eye, ColorToken::Text);
                canvas.put(top_row, x + 2, ">", ColorToken::Warning);
            }
        }
    }

    // 8. Creature 3: Tropical Angelfish
    if water_depth >= 4 && cols >= 32 {
        let min_x = 5i32;
        let max_x = (min_x + 2).max((cols as i32) - 11);
        let (w_pos, w_vel) = wander_1d(83.0);
        let x = round(min_x as f32 + w_pos * (max_x - min_x) as f32) as i32;
        let facing = if w_vel > 0.003 { "right" } else if w_vel < -0.003 { "left" } else { "turn" };
        let min_y = 2i32;
        let max_y = (min_y).max((floor as i32) - 3);
        let y_pos = wander_depth(103.0);
        let angel_row = round(min_y as f32 + y_pos * (max_y - min_y) as f32) as usize;
        let hunger = 0.5 + 0.45 * sin(u * (2.0 * core::f32::consts::PI / 26.0) + 0.5);
        let eye = if hunger >= 0.70 { "O" } else if hunger >= 0.35 { "•" } else { "'" };
        match facing {
            "right" => {
                canvas.put(angel_row, x + 1, "\\", ColorToken::Warning);
                canvas.put(angel_row + 1, x, ">=", ColorToken::Warning);
                let body = if eye == "O" { "_(O" } else if eye == "•" { "_(•" } else { "_('" };
                canvas.put(angel_row + 1, x + 2, body, ColorToken::Accent);
                canvas.put(angel_row + 1, x + 5, ">", ColorToken::Warning);
                if angel_row + 2 < floor { canvas.put(angel_row + 2, x + 1, "/", ColorToken::Warning); }
            }
            "left" => {
                canvas.put(angel_row, x + 1, "/", ColorToken::Warning);
                canvas.put(angel_row + 1, x, "<", ColorToken::Warning);
                let body = if eye == "O" { "O)_" } else if eye == "•" { "•)_" } else { "')_" };
                canvas.put(angel_row + 1, x + 1, body, ColorToken::Accent);
                canvas.put(angel_row + 1, x + 4, "=<", ColorToken::Warning);
                if angel_row + 2 < floor { canvas.put(angel_row + 2, x + 1, "\\", ColorToken::Warning); }
            }
            _ => {
                canvas.put(angel_row, x + 1, "|", ColorToken::Warning);
                canvas.put(angel_row + 1, x, "<(", ColorToken::Warning);
                canvas.put(angel_row + 1, x + 2, eye, ColorToken::Text);
                canvas.put(angel_row + 1, x + 3, ")>", ColorToken::Warning);
                if angel_row + 2 < floor { canvas.put(angel_row + 2, x + 1, "|", ColorToken::Warning); }
            }
        }
    }

    // 9. Creature 4: Pulsing Jellyfish
    if cols >= 38 && water_depth >= 4 {
        let jelly_cycle = 16.0f32;
        let j_prog = (u % jelly_cycle) / jelly_cycle;
        let j_row = ((floor as i32 - 2) - round(j_prog * (water_depth as f32 - 1.0)) as i32).clamp(2, (floor as i32) - 1) as usize;
        let drift = sin(u * (2.0 * core::f32::consts::PI / 24.0) + 1.5) * ((cols as f32 * 0.15).min(8.0));
        let jelly_col = round((cols as f32) * 0.72 + drift).clamp(4.0, (cols as f32) - 8.0) as i32;
        let pulse = ((u * 2.0) as u32) % 2 == 0;
        let hunger = 0.5 + 0.45 * sin(u * (2.0 * core::f32::consts::PI / 20.0) + 2.1);
        let face = if hunger >= 0.50 { "(• •)" } else if pulse { "(o o)" } else { "( - )" };
        canvas.put(j_row, jelly_col, ".-.", ColorToken::Accent);
        canvas.put(j_row + 1, jelly_col - 1, face, ColorToken::Accent);
        canvas.put(j_row + 2, jelly_col, if pulse { "~ ~" } else { "| |" }, ColorToken::Dim);
    }

    // 10. Creature 5: Little Crab on gravel bed
    if cols >= 30 {
        let (cw_pos, cw_vel) = wander_1d(137.0);
        let crab_min = 5i32;
        let stone_col = (cols as i32) - 5;
        let crab_max = (crab_min + 2).max(stone_col - 7);
        let crab_x = round(crab_min as f32 + cw_pos * (crab_max - crab_min) as f32) as i32;
        let hunger = 0.5 + 0.45 * sin(u * (2.0 * core::f32::consts::PI / 22.0) + 4.5);
        let scuttle = cw_vel.abs() > 0.003 && (((u * 4.0) as u32) % 2 == 0);
        let crab_sprite = if hunger >= 0.50 { "(\\??/)" } else if scuttle { "(\\,,/)" } else { "(\\_/)" };
        canvas.put(floor, crab_x, crab_sprite, ColorToken::Error);
    }
}
