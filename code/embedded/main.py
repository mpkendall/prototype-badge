from machine import Pin, SPI, PWM, ADC, unique_id
import time
import json
from display import DisplayManager, nice_fonts

display = DisplayManager()

logo = display.import_pbm("prototype-logo.pbm")

# Photodiode TIA circuit on ADC pin 2 (GPIO 28)
photodiode = ADC(Pin(28))
# Button on GPIO 13 with internal pull-up (active low)
button = Pin(13, Pin.IN, Pin.PULL_UP)

# Timing parameters (must match web flasher settings)
BIT_HOLD_MS = 120
BIT_GAP_MS = 50
SAMPLE_INTERVAL_MS = 10  # How often to sample the ADC

def crc8(data: bytes, poly: int = 0x07, init: int = 0x00) -> int:
    """Calculate CRC-8 checksum matching the web flasher."""
    crc = init & 0xFF
    for b in data:
        crc ^= b & 0xFF
        for _ in range(8):
            if crc & 0x80:
                crc = ((crc << 1) ^ poly) & 0xFF
            else:
                crc = (crc << 1) & 0xFF
    return crc & 0xFF

def read_photodiode_config():
    """Read encoded config data from photodiode while button is held."""
    print("Button pressed - starting photodiode read...")
    
    samples = []
    threshold = None
    bits = []
    
    # Collect samples while button is held
    while button.value() == 0:  # Button is active low
        val = photodiode.read_u16()
        samples.append(val)
        time.sleep_ms(SAMPLE_INTERVAL_MS)
    
    if len(samples) < 50:
        print(f"Not enough samples collected: {len(samples)}")
        return None
    
    print(f"Collected {len(samples)} samples")
    
    # Calculate threshold (midpoint between min and max)
    min_val = min(samples)
    max_val = max(samples)
    threshold = (min_val + max_val) // 2
    print(f"Min: {min_val}, Max: {max_val}, Threshold: {threshold}")
    
    if max_val - min_val < 1000:
        print("Signal too weak - not enough contrast between light levels")
        return None
    
    # Classify samples into three levels: 0=dark, 2=neutral, 1=bright
    span = max_val - min_val
    high_thresh = min_val + int(span * 0.70)
    low_thresh = min_val + int(span * 0.30)
    levels = []
    for s in samples:
        if s >= high_thresh:
            levels.append(1)
        elif s <= low_thresh:
            levels.append(0)
        else:
            levels.append(2)

    # Compute samples counts for hold and gap explicitly
    samples_per_hold = max(1, BIT_HOLD_MS // SAMPLE_INTERVAL_MS)
    samples_per_gap = max(0, BIT_GAP_MS // SAMPLE_INTERVAL_MS)

    bits = []
    i = 0
    # Search for aligned hold+gap windows and decode majority hold value
    while i + samples_per_hold <= len(levels):
        hold_window = levels[i:i + samples_per_hold]
        # Determine majority in hold window ignoring neutrals where possible
        ones = hold_window.count(1)
        zeros = hold_window.count(0)
        neutrals = hold_window.count(2)
        if ones + zeros == 0:
            # No clear hold value here, move forward
            i += 1
            continue
        bit_val = 1 if ones > zeros else 0

        # If there's a gap configured, verify the gap is present (prefer neutral)
        gap_ok = True
        if samples_per_gap > 0 and i + samples_per_hold + samples_per_gap <= len(levels):
            gap_window = levels[i + samples_per_hold: i + samples_per_hold + samples_per_gap]
            gap_neutrals = gap_window.count(2)
            # Accept gap if majority of gap samples are neutral or different from hold bit
            if gap_neutrals * 2 >= len(gap_window):
                gap_ok = True
            else:
                # If gap not neutral, ensure it's not the same as hold (otherwise likely misaligned)
                if gap_window.count(bit_val) > len(gap_window) // 2:
                    gap_ok = False
        # If gap_ok, accept this bit and advance by hold+gap; else shift by one sample and retry
        if gap_ok:
            bits.append(bit_val)
            i += samples_per_hold + samples_per_gap
        else:
            i += 1
    
    print(f"Decoded {len(bits)} bits: {''.join(str(b) for b in bits[:64])}...")
    
    if len(bits) < 8:
        print("Not enough bits decoded")
        return None
    
    # Convert bits to bytes (MSB first, matching web flasher)
    byte_count = len(bits) // 8
    data = bytearray(byte_count)
    for byte_idx in range(byte_count):
        byte_val = 0
        for bit_idx in range(8):
            bit_pos = byte_idx * 8 + bit_idx
            if bits[bit_pos]:
                byte_val |= (1 << (7 - bit_idx))
        data[byte_idx] = byte_val
    
    print(f"Decoded bytes: {data.hex()}")
    
    if len(data) < 2:
        print("Data too short")
        return None
    
    # Verify CRC-8 checksum (last byte)
    payload = bytes(data[:-1])
    received_crc = data[-1]
    calculated_crc = crc8(payload)
    
    if received_crc != calculated_crc:
        print(f"CRC mismatch: received 0x{received_crc:02x}, calculated 0x{calculated_crc:02x}")
        return None
    
    print("CRC verified OK")
    
    # Parse the payload: name\0handle\0pronouns
    try:
        decoded = payload.decode('utf-8')
        parts = decoded.split('\0')
        if len(parts) >= 3:
            name, handle, pronouns = parts[0], parts[1], parts[2]
        elif len(parts) == 2:
            name, handle, pronouns = parts[0], parts[1], ''
        else:
            name, handle, pronouns = parts[0], '', ''
        
        config = {
            "userName": name,
            "userHandle": handle,
            "userPronouns": pronouns
        }
        print(f"Decoded config: {config}")
        return config
    except Exception as e:
        print(f"Failed to parse payload: {e}")
        return None

def save_config(config: dict):
    """Save config to config.json."""
    try:
        with open("config.json", "w") as f:
            json.dump(config, f)
        print("Config saved to config.json")
        return True
    except Exception as e:
        print(f"Failed to save config: {e}")
        return False

def check_button_and_read():
    """Check if button is pressed and read photodiode data."""
    if button.value() == 0:  # Button pressed (active low)
        time.sleep_ms(50)  # Debounce
        if button.value() == 0:  # Still pressed
            config = read_photodiode_config()
            if config:
                if save_config(config):
                    display.fill(1)
                    display.nice_text("Config\nSaved!", 10, 10, font=32)
                    display.nice_text(config.get("userName", "")[:15], 10, 80, font=24)
                    display.show(rotate=90)
                    time.sleep(2)
                    # Reset to show new badge
                    import machine
                    machine.reset()
                else:
                    print("Failed to save config")
            else:
                print("Failed to read config - try again")

# Check for button press at startup
check_button_and_read()

def decide_name_size(name: str, y_space_available: int = 170):
    font = None
    max_chars_for_sizes = {size: display.display.width // f.max_width for size, f in nice_fonts.items()}

    for size, max_chars in sorted(max_chars_for_sizes.items(), key=lambda x: x[0], reverse=True):
        if size < 24:
            continue
        if len(name) <= max_chars and size <= y_space_available:
            font = nice_fonts[size]
            return font, name

        if ' ' in name:
            parts = name.split(' ')
            mid = len(parts) // 2
            test_name = ' '.join(parts[:mid]) + '\n' + ' '.join(parts[mid:])
            if max(len(part) for part in test_name.split('\n')) <= max_chars and 2 * size <= y_space_available:
                font = nice_fonts[size]
                return font, test_name

            lines_available = y_space_available // size
            if len(parts) <= lines_available and max(len(part) for part in parts) <= max_chars:
                font = nice_fonts[size]
                return font, '\n'.join(parts)

    for size, max_chars in sorted(max_chars_for_sizes.items(), key=lambda x: x[0], reverse=True):
        if size < 24:
            continue
        lines_available = max(1, y_space_available // size)
        chunk = max(1, (max_chars - 1))
        if (len(name) // lines_available) <= chunk:
            hyph = '-\n'.join(name[i:i + chunk] for i in range(0, len(name), chunk))
            font = nice_fonts[size]
            return font, hyph

    font = nice_fonts[18]
    chunk = 10
    name = '-\n'.join([name[i:i + chunk] for i in range(0, len(name), chunk)][:7])
    return font, name


badge_data = {
    "name": None,
    "pronouns": None,
    "slack_handle": None
}

configured = False
try:
    with open("config.json", "r") as f:
        import json
        config = json.load(f)
        badge_data["name"] = config.get("userName")
        badge_data["pronouns"] = config.get("userPronouns")
        badge_data["slack_handle"] = config.get("userHandle")
        configured = True
except Exception:
    pass

display.fill(1)

if configured:
    top_margin = 0
    gap = 4
    pron_font = nice_fonts[24]
    handle_font = nice_fonts[32]

    handle_text = ('@' + badge_data["slack_handle"]) if badge_data.get("slack_handle") and not badge_data["slack_handle"].startswith('@') else badge_data.get("slack_handle", '')
    max_handle_chars = display.display.width // handle_font.max_width if handle_text else 0
    handle_wrapped = [handle_text[i:i + max_handle_chars] for i in range(0, len(handle_text), max_handle_chars)] if handle_text else []
    handle_height = len(handle_wrapped) * handle_font.height
    pron_height = pron_font.height if badge_data.get("pronouns") else 0

    y_space_for_name = 170 - top_margin - pron_height - handle_height - (gap * ((1 if pron_height else 0) + (1 if handle_height else 0)))

    name_font, name_text = decide_name_size(badge_data["name"], y_space_for_name)

    y = top_margin
    display.nice_text(name_text, 10, y, font=name_font)
    name_height = name_font.height * (name_text.count('\n') + 1)

    if badge_data.get("pronouns"):
        y = y + name_height + gap
        display.nice_text(badge_data["pronouns"], 10, y, font=pron_font)
        pron_y = y
    else:
        pron_y = top_margin + name_height

    if handle_wrapped:
        y = pron_y + (pron_height if pron_height else 0) + gap
        display.nice_text('\n'.join(handle_wrapped), 10, y, font=handle_font)

    display.fill_rect(0, 155, 200, 5, 0)
    display.blit(logo, 0, 170)
else:
    display.nice_text("Firmware Flashed!", 0, 10, font=24)
    display.fill_rect(0, 50, 200, 4, 0)
    display.nice_text("Enter your details\non the flasher to and\nhit \"save\" to see it!", 10, 70, font=18)

display.show(rotate=-90)

# Main loop - continuously monitor button for photodiode reading
print("Badge displayed. Hold button (GPIO 13) to read new config from photodiode...")
while True:
    check_button_and_read()
    time.sleep_ms(100)