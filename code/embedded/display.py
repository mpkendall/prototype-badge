import einkdriver
import framebuf
try:
    from typing import Union
except ImportError:
    pass
from machine import Pin, SPI # pyright: ignore[reportMissingImports]
from microfont import MicroFont

nice_fonts = {
    18: MicroFont("fonts/victor_B_18.mfnt"),
    24: MicroFont("fonts/victor_B_24.mfnt"),
    32: MicroFont("fonts/victor_B_32.mfnt"),
    42: MicroFont("fonts/victor_B_42.mfnt"),
    54: MicroFont("fonts/victor_B_54.mfnt"),
    68: MicroFont("fonts/victor_B_68.mfnt"),
}

class DisplayManager:
    def __init__(self):
        self.spi = SPI(0, baudrate=1_000_000, polarity=0, phase=0, sck=Pin(18), mosi=Pin(19), miso=Pin(20))

        self.cs = Pin(24, Pin.OUT)
        self.dc = Pin(25, Pin.OUT)
        self.rst = Pin(26, Pin.OUT)
        self.busy = Pin(27, Pin.IN)

        self.display = einkdriver.EPD(self.spi, self.cs, self.dc, self.rst, self.busy)
        self.display.init()

    def show(self):
        self.display.display()

    def fill(self, color):
        self.display.fill(color)

    def pixel(self, x, y, color):
        self.display.pixel(x, y, color)
    
    def hline(self, x, y, w, color):
        self.display.hline(x, y, w, color)

    def vline(self, x, y, h, color):
        self.display.vline(x, y, h, color)

    def line(self, x1, y1, x2, y2, color):
        self.display.line(x1, y1, x2, y2, color)

    def rect(self, x, y, w, h, color):
        self.display.rect(x, y, w, h, color)

    def fill_rect(self, x, y, w, h, color):
        self.display.fill_rect(x, y, w, h, color)

    def text(self, string, x, y, color):
        self.display.text(string, x, y, color)

    def nice_text(self, text: str, x: int, y: int, font: Union[int, MicroFont] = 18, color: int = 0, *, rot: int = 0, x_spacing: int = 0, y_spacing: int = 0) -> None:
        """
        Draw text using a nice font.
        Included fonts are Victor Mono Bold in 18, 24, 32, 42, 54, and 68 point sizes.
        If these are not adequate, you can provide a MicroFont instance with your own font.
        :param text: The text to draw.
        :param x: X coordinate of the text.
        :param y: Y coordinate of the text.
        :param font: Font size or a MicroFont instance. Default is 18.
        :param color: Color of the text (0=black, 1=white).
        :param rot: Rotation angle in degrees.
        :param x_spacing: Horizontal spacing between characters.
        :param y_spacing: Vertical spacing between lines.
        """
        if isinstance(font, int):
            font = nice_fonts.get(font)
        
        if not font:
            raise ValueError(f"Invalid font size. Available built-in sizes: {', '.join(map(str, nice_fonts.keys()))}, or provide a MicroFont instance with your own font.")
        
        font.write(text, self.display.framebuf, framebuf.MONO_HLSB, self.display.width, self.display.height, x, y, color, rot=rot, x_spacing=x_spacing, y_spacing=y_spacing)

    def blit(self, fb, x: int, y: int):
        self.display.blit(fb, x, y)

    def import_pbm(self, file_path: str) -> framebuf.FrameBuffer:
        with open(file_path, 'rb') as f:
            # Read the header
            header = f.readline().strip()
            if header != b'P4':
                raise ValueError("File is not a valid binary PBM file.")
            # Read the width and height
            dimensions = f.readline().strip()
            width, height = map(int, dimensions.split())
            # Read the pixel data
            pixel_data = bytearray(~b & 0xFF for b in f.read()) # the e-ink means the PBM format swaps black and white
            if len(pixel_data) != (width * height + 7) // 8:
                raise ValueError("Pixel data does not match specified dimensions.")
            # Create a FrameBuffer from the pixel data
            fb = framebuf.FrameBuffer(pixel_data, width, height, framebuf.MONO_HLSB)
        return fb
