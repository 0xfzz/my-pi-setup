#![no_std]

pub mod canvas;
pub mod scenes;

use canvas::{Canvas, MAX_BUFFER};
use scenes::{fire, matrix, aquarium};

#[panic_handler]
fn panic(_info: &core::panic::PanicInfo) -> ! {
    loop {}
}

static mut CANVAS: Canvas = Canvas::new();
static mut BUFFER: [u8; MAX_BUFFER] = [0u8; MAX_BUFFER];
static mut BUFFER_LEN: usize = 0;

#[no_mangle]
pub extern "C" fn get_buffer_ptr() -> *const u8 {
    unsafe { core::ptr::addr_of!(BUFFER) as *const u8 }
}

#[no_mangle]
pub extern "C" fn render_scene(scene_id: u32, cols: u32, rows: u32, seconds: f32, use_ansi: u32) -> u32 {
    let cols = cols as usize;
    let rows = rows as usize;
    let ansi = use_ansi != 0;

    unsafe {
        let canvas = &mut *core::ptr::addr_of_mut!(CANVAS);
        let buffer = &mut *core::ptr::addr_of_mut!(BUFFER);

        canvas.reset(cols, rows);

        match scene_id {
            scenes::SCENE_AQUARIUM => aquarium::render(canvas, seconds),
            scenes::SCENE_MATRIX => matrix::render(canvas, seconds),
            scenes::SCENE_FIRE => fire::render(canvas, seconds),
            _ => aquarium::render(canvas, seconds),
        }

        BUFFER_LEN = canvas.serialize(buffer, ansi);
        BUFFER_LEN as u32
    }
}

// Named scene entrypoints
#[no_mangle]
pub extern "C" fn render_aquarium(cols: u32, rows: u32, seconds: f32, use_ansi: u32) -> u32 {
    render_scene(scenes::SCENE_AQUARIUM, cols, rows, seconds, use_ansi)
}

#[no_mangle]
pub extern "C" fn render_matrix(cols: u32, rows: u32, seconds: f32, use_ansi: u32) -> u32 {
    render_scene(scenes::SCENE_MATRIX, cols, rows, seconds, use_ansi)
}

#[no_mangle]
pub extern "C" fn render_fire(cols: u32, rows: u32, seconds: f32, use_ansi: u32) -> u32 {
    render_scene(scenes::SCENE_FIRE, cols, rows, seconds, use_ansi)
}

// Backward-compatible alias
#[no_mangle]
pub extern "C" fn render_frame(cols: u32, rows: u32, seconds: f32, use_ansi: u32) -> u32 {
    render_aquarium(cols, rows, seconds, use_ansi)
}
