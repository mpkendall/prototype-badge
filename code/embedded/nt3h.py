import time

class NFCManager():
    def __init__(self, i2c, address=0x55):
        self.i2c = i2c
        self.address = address

    def read_page(self, page):
        """
        Reads a single 16-byte page from the NT3H2111/2211.
        Tries a few different I2C methods to be compatible with different
        MicroPython / board implementations.
        """
        try:
            # 1) If the I2C has a readfrom_mem helper, use it (clean register read)
            if hasattr(self.i2c, 'readfrom_mem'):
                try:
                    return self.i2c.readfrom_mem(self.address, page, 16)
                except Exception:
                    # fall through to other methods
                    pass

            # 2) Use writeto_then_readfrom (repeated start) if available
            if hasattr(self.i2c, 'writeto_then_readfrom'):
                buffer = bytearray(16)
                try:
                    self.i2c.writeto_then_readfrom(self.address, bytes([page]), buffer)
                    return buffer
                except Exception:
                    # fall through
                    pass

            # 3) Fallback: write the page address then read (may send STOP)
            # Some I2C implementations don't accept a stop= keyword, so call
            # writeto with the address-only argument and then readfrom.
            try:
                self.i2c.writeto(self.address, bytes([page]))
                return self.i2c.readfrom(self.address, 16)
            except TypeError:
                # older/alternate signatures — try again without extra params
                try:
                    self.i2c.writeto(self.address, bytes([page]))
                    return self.i2c.readfrom(self.address, 16)
                except Exception as e:
                    raise e
        except Exception as e:
            print(f"NFC Read Error on page {page}: {e}")
            return None

    def write_page(self, page, data):
        """
        Writes a single 16-byte page to the NT3H2111/2211.
        """
        if len(data) != 16:
            print("Error: Data must be exactly 16 bytes.")
            return False
        
        try:
            self.i2c.writeto(self.address, bytes([page]) + data)
            # Datasheet specifies a write time (T_write) of max 5ms
            if hasattr(time, 'sleep_ms'):
                time.sleep_ms(5)
            else:
                time.sleep(0.005)
            return True
        except Exception as e:
            print(f"NFC Write Error on page {page}: {e}")
            return False

    def read_pages(self, start_page, num_pages):
        """
        Reads multiple pages starting from start_page.
        """
        data = bytearray()
        for i in range(num_pages):
            page_data = self.read_page(start_page + i)
            if page_data:
                data.extend(page_data)
            else:
                return None
        return data

    def write_pages(self, start_page, data):
        """
        Writes multiple pages starting from start_page. 
        Data length must be a multiple of 16 bytes.
        """
        if len(data) % 16 != 0:
            print("Error: Data length must be a multiple of 16 bytes.")
            return False
        
        num_pages = len(data) // 16
        for i in range(num_pages):
            chunk = data[i*16 : (i+1)*16]
            if not self.write_page(start_page + i, chunk):
                return False
        return True

    def write_url(self, url):
        """
        Encodes a URL as an NDEF record and writes it to the tag starting at Page 4.
        This allows a phone to open the URL when scanned.
        """
        # Identify protocol prefix to save bytes
        prefix = 0x00
        body = url
        if url.startswith("http://www."):
            prefix = 0x01
            body = url[11:]
        elif url.startswith("https://www."):
            prefix = 0x02
            body = url[12:]
        elif url.startswith("http://"):
            prefix = 0x03
            body = url[7:]
        elif url.startswith("https://"):
            prefix = 0x04
            body = url[8:]
            
        payload = bytes([prefix]) + body.encode('utf-8')
        
        # Construct NDEF Message
        # Header: MB=1, ME=1, SR=1, TNF=0x01 (Well Known) -> 0xD1
        # Type Length: 0x01
        # Payload Length: len(payload)
        # Type: 'U' (0x55)
        # Payload: payload
        
        if len(payload) > 254:
            print("URL too long")
            return False
            
        ndef_record = bytes([0xD1, 0x01, len(payload), 0x55]) + payload
        
        # 0x03, Length, Value, 0xFE (Terminator)
        tlv = bytes([0x03, len(ndef_record)]) + ndef_record + bytes([0xFE])
        
        # Pad to 16-byte paages
        pad_size = (16 - (len(tlv) % 16)) % 16
        data = tlv + bytes([0x00] * pad_size)
        
        return self.write_pages(4, data)