from machine import I2C, Pin
import time
from nt3h import NFCManager

i2c = I2C(1, scl=Pin(11), sda=Pin(10))

print("Scanning I2C bus...")
devices = i2c.scan()
print("Found devices:", devices)

NT3H_ADDR = 0x55
if NT3H_ADDR in devices:
    print("NT3H device detected at 0x55")
else:
    print("NT3H device not found on I2C bus")

nfc = NFCManager(i2c)
url = "https://example.com"
print(f"Writing URL: {url}")
if nfc.write_url(url):
    print("Write successful, reading back pages 4-9...")
    data = nfc.read_pages(4, 6)  # read 6 pages (4..9)
    if data:
        print("Read back:", data)
    else:
        print("Failed to read back data")
else:
    print("Write failed")
