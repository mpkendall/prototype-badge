from machine import Pin, SPI, PWM, unique_id
from display import DisplayManager, nice_fonts

display = DisplayManager()

logo = display.import_pbm("prototype-logo.pbm")

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
    display.nice_text("Not Configured!", 10, 10, font=24)
    display.fill_rect(0, 50, 200, 5, 0)
    display.nice_text("badge.blueprint\n.hackclub.com", 10, 70, font=24)

display.show()