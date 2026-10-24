use crate::canvas::{Canvas, ColorToken, hash, round};

const GLYPHS: &[char] = &[
    '0', '1', '2', '3', '4', '5', '6', '7', '8', '9',
    'A', 'B', 'C', 'D', 'E', 'F', 'X', 'Y', 'Z',
    'ｱ', 'ｲ', 'ｳ', 'ｴ', 'ｵ', 'ｶ', 'ｷ', 'ｹ', 'ｺ', 'ｻ', 'ｼ', 'ｽ', 'ｾ', 'ｿ',
    'ﾀ', 'ﾂ', 'ﾃ', 'ﾅ', 'ﾆ', 'ﾇ', 'ﾈ', 'ﾊ', 'ﾋ', 'ﾎ', 'ﾏ', 'ﾐ', 'ﾑ', 'ﾒ', 'ﾓ', 'ﾔ', 'ﾕ', 'ﾗ', 'ﾘ', 'ﾜ',
];

pub fn render(canvas: &mut Canvas, seconds: f32) {
    let cols = canvas.cols;
    let rows = canvas.rows;
    canvas.draw_box_border();

    let inner_height = (rows - 2) as f32;
    let num_glyphs = GLYPHS.len() as u32;

    for c in 1..cols - 1 {
        let seed = (c * 17) as u32;
        let speed = 2.5 + hash(seed, 1) * 3.5;
        let offset = hash(seed, 2) * 20.0;
        let trail_len = round(4.0 + hash(seed, 3) * 5.0) as i32;

        let head_y = ((seconds * speed + offset) % (inner_height + trail_len as f32 + 3.0)) - trail_len as f32;
        let head_row = round(head_y) as i32 + 1;

        for t in 0..=trail_len {
            let r = head_row - t;
            if r >= 1 && (r as usize) < rows - 1 {
                let char_idx = ((hash(seed + (r as u32) * 7, (seconds * 4.0) as u32) * (num_glyphs as f32)) as usize) % GLYPHS.len();
                let glyph = GLYPHS[char_idx];
                let color = if t == 0 {
                    ColorToken::Text // Glowing white head
                } else if t <= 2 {
                    ColorToken::Success // Bright green
                } else if t <= trail_len - 2 {
                    ColorToken::Success // Green
                } else {
                    ColorToken::Dim // Fading green tail
                };
                canvas.grid[r as usize][c] = crate::canvas::Cell { ch: glyph, color };
            }
        }
    }
}
