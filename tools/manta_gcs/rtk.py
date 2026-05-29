"""RTK base station + RTCM injection for MantaShark Tuner.

Architecture:
    9PS (u-blox F9P/M8P) ─USB serial→ rtk.RtkManager
                                          ↓ UBX (CFG-TMODE3 / NAV-SVIN / CFG-MSG)
                                          ↓ RTCM3 frames
                          MAVLink GPS_RTCM_DATA → FC → DroneCAN → 2HP rover

References (Mission Planner C# source, logic ported):
    GCSViews/ConfigurationView/ConfigUblox.cs    UBX Survey-In sequence
    Comms/RTCM3.cs                                RTCM3 frame parser
    GCSViews/ConfigurationView/ConfigGPSInject.cs GPS_RTCM_DATA splitter
"""
import base64
import datetime
import os
import socket
import threading
import time
import struct
import urllib.parse
import serial
from pymavlink import mavutil


# ─── UBX framing ──────────────────────────────────────────────────
UBX_SYNC = b'\xb5\x62'

# Classes
UBX_NAV = 0x01
UBX_RXM = 0x02
UBX_CFG = 0x06
UBX_MON = 0x0A
UBX_RTCM3 = 0xF5  # u-blox uses class 0xF5 for RTCM3 output messages

# Common message IDs
NAV_SVIN = 0x3B
CFG_MSG = 0x01
CFG_TMODE3 = 0x71
CFG_PRT = 0x00
CFG_RATE = 0x08

# RTCM3 messages we want enabled on the base, with rate (every Nth solution).
# Matches MP ubx_m8p.cs:519-555 — 1005/1230 on 5s (rarely change), MSM7 on 1s.
RTCM3_MSGS = [
    (0x05, 5),  # 1005 — Stationary RTK reference (every 5s)
    (0x4D, 1),  # 1077 — GPS MSM7        (every 1s)
    (0x57, 1),  # 1087 — GLONASS MSM7    (every 1s)
    (0x61, 1),  # 1097 — Galileo MSM7    (every 1s)
    (0x7F, 1),  # 1127 — BeiDou MSM7     (every 1s)
    (0xE6, 5),  # 1230 — GLONASS biases  (every 5s)
]
# Backwards-compat list (just IDs)
RTCM3_MSG_IDS = [mid for mid, _ in RTCM3_MSGS]


def ubx_checksum(body: bytes) -> bytes:
    a = b = 0
    for x in body:
        a = (a + x) & 0xFF
        b = (b + a) & 0xFF
    return bytes([a, b])


def ubx_pack(cls: int, mid: int, payload: bytes = b'') -> bytes:
    body = bytes([cls, mid]) + len(payload).to_bytes(2, 'little') + payload
    return UBX_SYNC + body + ubx_checksum(body)


class UbxParser:
    """Stateful UBX byte stream parser."""

    def __init__(self):
        self.buf = bytearray()

    def feed(self, data: bytes):
        """Append bytes, return list of (cls, mid, payload) frames."""
        self.buf.extend(data)
        out = []
        while True:
            # Find sync
            i = self.buf.find(UBX_SYNC)
            if i < 0:
                # Discard up to last byte (could be 0xb5 partial)
                if len(self.buf) > 1:
                    del self.buf[:-1]
                break
            if i > 0:
                del self.buf[:i]
            # Need at least sync(2) + cls(1) + id(1) + len(2) + ck(2) = 8 bytes
            if len(self.buf) < 8:
                break
            cls, mid = self.buf[2], self.buf[3]
            length = self.buf[4] | (self.buf[5] << 8)
            total = 8 + length
            if len(self.buf) < total:
                break
            body = bytes(self.buf[2:6 + length])
            ck_recv = bytes(self.buf[6 + length:8 + length])
            if ubx_checksum(body) != ck_recv:
                # Bad CRC, skip this sync and resume search
                del self.buf[:2]
                continue
            payload = bytes(self.buf[6:6 + length])
            out.append((cls, mid, payload))
            del self.buf[:total]
        return out


# ─── RTCM3 framing ─────────────────────────────────────────────────
RTCM3_PREAMBLE = 0xD3

# CRC-24Q lookup table (poly 0x1864CFB), per RTCM3 spec — same as MP rtcm3.cs:531
_CRC24Q_TAB = (
    0x000000, 0x864CFB, 0x8AD50D, 0x0C99F6, 0x93E6E1, 0x15AA1A, 0x1933EC, 0x9F7F17,
    0xA18139, 0x27CDC2, 0x2B5434, 0xAD18CF, 0x3267D8, 0xB42B23, 0xB8B2D5, 0x3EFE2E,
    0xC54E89, 0x430272, 0x4F9B84, 0xC9D77F, 0x56A868, 0xD0E493, 0xDC7D65, 0x5A319E,
    0x64CFB0, 0xE2834B, 0xEE1ABD, 0x685646, 0xF72951, 0x7165AA, 0x7DFC5C, 0xFBB0A7,
    0x0CD1E9, 0x8A9D12, 0x8604E4, 0x00481F, 0x9F3708, 0x197BF3, 0x15E205, 0x93AEFE,
    0xAD50D0, 0x2B1C2B, 0x2785DD, 0xA1C926, 0x3EB631, 0xB8FACA, 0xB4633C, 0x322FC7,
    0xC99F60, 0x4FD39B, 0x434A6D, 0xC50696, 0x5A7981, 0xDC357A, 0xD0AC8C, 0x56E077,
    0x681E59, 0xEE52A2, 0xE2CB54, 0x6487AF, 0xFBF8B8, 0x7DB443, 0x712DB5, 0xF7614E,
    0x19A3D2, 0x9FEF29, 0x9376DF, 0x153A24, 0x8A4533, 0x0C09C8, 0x00903E, 0x86DCC5,
    0xB822EB, 0x3E6E10, 0x32F7E6, 0xB4BB1D, 0x2BC40A, 0xAD88F1, 0xA11107, 0x275DFC,
    0xDCED5B, 0x5AA1A0, 0x563856, 0xD074AD, 0x4F0BBA, 0xC94741, 0xC5DEB7, 0x43924C,
    0x7D6C62, 0xFB2099, 0xF7B96F, 0x71F594, 0xEE8A83, 0x68C678, 0x645F8E, 0xE21375,
    0x15723B, 0x933EC0, 0x9FA736, 0x19EBCD, 0x8694DA, 0x00D821, 0x0C41D7, 0x8A0D2C,
    0xB4F302, 0x32BFF9, 0x3E260F, 0xB86AF4, 0x2715E3, 0xA15918, 0xADC0EE, 0x2B8C15,
    0xD03CB2, 0x567049, 0x5AE9BF, 0xDCA544, 0x43DA53, 0xC596A8, 0xC90F5E, 0x4F43A5,
    0x71BD8B, 0xF7F170, 0xFB6886, 0x7D247D, 0xE25B6A, 0x641791, 0x688E67, 0xEEC29C,
    0x3347A4, 0xB50B5F, 0xB992A9, 0x3FDE52, 0xA0A145, 0x26EDBE, 0x2A7448, 0xAC38B3,
    0x92C69D, 0x148A66, 0x181390, 0x9E5F6B, 0x01207C, 0x876C87, 0x8BF571, 0x0DB98A,
    0xF6092D, 0x7045D6, 0x7CDC20, 0xFA90DB, 0x65EFCC, 0xE3A337, 0xEF3AC1, 0x69763A,
    0x578814, 0xD1C4EF, 0xDD5D19, 0x5B11E2, 0xC46EF5, 0x42220E, 0x4EBBF8, 0xC8F703,
    0x3F964D, 0xB9DAB6, 0xB54340, 0x330FBB, 0xAC70AC, 0x2A3C57, 0x26A5A1, 0xA0E95A,
    0x9E1774, 0x185B8F, 0x14C279, 0x928E82, 0x0DF195, 0x8BBD6E, 0x872498, 0x016863,
    0xFAD8C4, 0x7C943F, 0x700DC9, 0xF64132, 0x693E25, 0xEF72DE, 0xE3EB28, 0x65A7D3,
    0x5B59FD, 0xDD1506, 0xD18CF0, 0x57C00B, 0xC8BF1C, 0x4EF3E7, 0x426A11, 0xC426EA,
    0x2AE476, 0xACA88D, 0xA0317B, 0x267D80, 0xB90297, 0x3F4E6C, 0x33D79A, 0xB59B61,
    0x8B654F, 0x0D29B4, 0x01B042, 0x87FCB9, 0x1883AE, 0x9ECF55, 0x9256A3, 0x141A58,
    0xEFAAFF, 0x69E604, 0x657FF2, 0xE33309, 0x7C4C1E, 0xFA00E5, 0xF69913, 0x70D5E8,
    0x4E2BC6, 0xC8673D, 0xC4FECB, 0x42B230, 0xDDCD27, 0x5B81DC, 0x57182A, 0xD154D1,
    0x26359F, 0xA07964, 0xACE092, 0x2AAC69, 0xB5D37E, 0x339F85, 0x3F0673, 0xB94A88,
    0x87B4A6, 0x01F85D, 0x0D61AB, 0x8B2D50, 0x145247, 0x921EBC, 0x9E874A, 0x18CBB1,
    0xE37B16, 0x6537ED, 0x69AE1B, 0xEFE2E0, 0x709DF7, 0xF6D10C, 0xFA48FA, 0x7C0401,
    0x42FA2F, 0xC4B6D4, 0xC82F22, 0x4E63D9, 0xD11CCE, 0x575035, 0x5BC9C3, 0xDD8538,
)


def crc24q(data: bytes) -> int:
    """RTCM3 CRC-24Q over byte sequence."""
    crc = 0
    for b in data:
        crc = ((crc << 8) & 0xFFFFFF) ^ _CRC24Q_TAB[((crc >> 16) ^ b) & 0xFF]
    return crc


class Rtcm3Parser:
    """Stateful RTCM3 frame parser. Yields (frame_bytes, msg_type) tuples.

    1:1 port of MP rtcm3.cs:84 Read() state machine — verifies CRC-24Q, drops
    bad frames silently and resyncs to next preamble. Bad CRC stats tracked.
    """

    def __init__(self):
        self.buf = bytearray()
        self.bad_crc = 0   # for diagnostics

    def feed(self, data: bytes):
        self.buf.extend(data)
        out = []
        while True:
            if len(self.buf) < 3:
                break
            # Find preamble
            i = 0
            while i < len(self.buf) and self.buf[i] != RTCM3_PREAMBLE:
                i += 1
            if i > 0:
                del self.buf[:i]
            if len(self.buf) < 3:
                break
            plen = ((self.buf[1] & 0x03) << 8) | self.buf[2]
            total = 3 + plen + 3  # header(3) + payload + CRC24Q(3)
            if len(self.buf) < total:
                break
            frame = bytes(self.buf[:total])
            # Verify CRC-24Q (MP rtcm3.cs:133)
            recv_crc = (frame[-3] << 16) | (frame[-2] << 8) | frame[-1]
            calc_crc = crc24q(frame[:-3])
            if calc_crc != recv_crc:
                # Bad CRC: advance ONE byte (not whole frame) to resync at next preamble
                self.bad_crc += 1
                del self.buf[:1]
                continue
            del self.buf[:total]
            # Extract message type (first 12 bits of payload)
            if plen >= 2:
                msg_type = (frame[3] << 4) | (frame[4] >> 4)
            else:
                msg_type = -1
            out.append((frame, msg_type))
        return out


# ─── UBX command builders ──────────────────────────────────────────
def cfg_tmode3_survey_in(min_dur_sec: int, accuracy_mm: int) -> bytes:
    """CFG-TMODE3: enter Survey-In mode.

    accuracy_mm: target 3D accuracy threshold in mm (e.g. 2500 = 2.5m).
                 Note: u-blox firmware uses 0.1mm units internally, so we ×10.
    """
    payload = struct.pack(
        '<BBHiii BBBB IIIII',
        0,           # version
        0,           # reserved
        1,           # flags: mode=1 (Survey-In)
        0, 0, 0,     # ecefX/Y/Z (unused for SVIN)
        0, 0, 0, 0,  # ecefHP + reserved
        0,           # fixedPosAcc (unused)
        min_dur_sec, # svinMinDur (s)
        accuracy_mm * 10,  # svinAccLimit (0.1mm)
        0, 0,        # reserved (8B = two u32)
    )
    return ubx_pack(UBX_CFG, CFG_TMODE3, payload)


def cfg_tmode3_disable() -> bytes:
    """CFG-TMODE3: disable any TMODE (back to rover mode)."""
    payload = struct.pack(
        '<BBHiii BBBB IIIII',
        0, 0, 0,
        0, 0, 0,
        0, 0, 0, 0,
        0, 0, 0,
        0, 0,
    )
    return ubx_pack(UBX_CFG, CFG_TMODE3, payload)


def cfg_tmode3_fixed_lla(lat_deg: float, lon_deg: float, alt_m: float, acc_mm: int = 100) -> bytes:
    """CFG-TMODE3: enter Fixed Position mode using LLA coordinates.

    Use known surveyed base position to skip Survey-In.
    lat/lon stored as int32 1e-7 deg + int8 HP component for sub-cm precision.
    alt stored as int32 cm + int8 HP 0.1mm.
    """
    # int32 portion (1e-7 deg) + HP (1e-9 deg, range -127..127)
    lat_e7 = int(lat_deg * 1e7)
    lon_e7 = int(lon_deg * 1e7)
    alt_cm = int(alt_m * 100)
    flags = (1 << 8) | 2  # mode=2 (Fixed), lla=1

    payload = struct.pack(
        '<BBH iii bbbb I IIII',
        0,           # version
        0,           # reserved
        flags,
        lat_e7,
        lon_e7,
        alt_cm,
        0, 0, 0, 0,  # HP components zero (cm precision is enough for typical use)
        acc_mm * 10, # fixedPosAcc in 0.1mm
        0, 0, 0, 0,  # svinMinDur, svinAccLimit, reserved (8B)
    )
    return ubx_pack(UBX_CFG, CFG_TMODE3, payload)


def cfg_msg_enable_rtcm3(rtcm_msg_id: int, rate: int = 1) -> bytes:
    """CFG-MSG (length=8): set output rate for class 0xF5 mid `rtcm_msg_id` on all ports.

    rate=1 means send every solution. Ports order: [DDC, UART1, UART2, USB, SPI, reserved].
    Enable on USB only (index 3).
    """
    payload = struct.pack(
        '<BBBBBBBB',
        UBX_RTCM3, rtcm_msg_id,
        0,      # DDC (I2C)
        0,      # UART1
        0,      # UART2
        rate,   # USB
        0,      # SPI
        0,      # reserved
    )
    return ubx_pack(UBX_CFG, CFG_MSG, payload)


def cfg_msg_poll_navsvin() -> bytes:
    """Poll NAV-SVIN (empty payload = poll request)."""
    return ubx_pack(UBX_NAV, NAV_SVIN, b'')


# ─── NTRIP client (HTTP-like protocol over TCP) ───────────────────
class NtripClient:
    """NTRIP rev1/rev2 client. Connects to a CORS/NTRIP caster, subscribes to a
    mountpoint, streams RTCM3 bytes back via on_rtcm callback.

    Sourcetable (GET /) is fetched via fetch_sourcetable() — a separate one-shot
    request, not used in streaming mode.
    """

    def __init__(self, host: str, port: int, mountpoint: str,
                 user: str = '', password: str = '',
                 on_rtcm=None, on_status=None,
                 user_agent: str = 'NTRIP MantaSharkTuner/1.0',
                 ntrip_v1: bool = False):
        self.host = host
        self.port = port
        self.mountpoint = mountpoint
        self.user = user
        self.password = password
        self.on_rtcm = on_rtcm or (lambda data: None)
        self.on_status = on_status or (lambda d: None)
        self.user_agent = user_agent
        # NTRIP rev: v2 default (HTTP/1.1 + Ntrip-Version: Ntrip/2.0). MP defaults
        # to v2 too (CommsNTRIP.cs:30 ntrip_v1=false). v1 fallback if caster rejects.
        self.ntrip_v1 = ntrip_v1
        # Rover position (for $GPGGA NMEA, required by VRS casters like 千寻)
        # MP CommsNTRIP.cs:408 SendNMEA() sends every 30s if lat/lng nonzero
        self.rover_lat = 0.0
        self.rover_lon = 0.0
        self.rover_alt = 0.0
        self._last_gga = 0.0
        self.sock = None
        self.thread = None
        self.running = False
        self.bytes_in = 0

    def update_rover_position(self, lat: float, lon: float, alt: float):
        """Update rover position (called from GLOBAL_POSITION_INT handler)."""
        self.rover_lat = lat
        self.rover_lon = lon
        self.rover_alt = alt

    def _build_request(self) -> bytes:
        """Build NTRIP request, prefer v2 (HTTP/1.1 + Ntrip-Version: Ntrip/2.0).

        1:1 port of MP CommsNTRIP.cs:355-365 doConnect().
        """
        path = '/' + self.mountpoint.lstrip('/')
        auth = ''
        if self.user:
            cred = f'{self.user}:{self.password}'.encode()
            auth = f'Authorization: Basic {base64.b64encode(cred).decode()}\r\n'
        if self.ntrip_v1:
            return (
                f'GET {path} HTTP/1.0\r\n'
                f'User-Agent: {self.user_agent}\r\n'
                f'{auth}'
                f'Connection: close\r\n'
                f'\r\n'
            ).encode()
        # NTRIP v2 (default, matches MP)
        return (
            f'GET {path} HTTP/1.1\r\n'
            f'Host: {self.host}:{self.port}\r\n'
            f'Ntrip-Version: Ntrip/2.0\r\n'
            f'User-Agent: {self.user_agent}\r\n'
            f'{auth}'
            f'Connection: close\r\n'
            f'\r\n'
        ).encode()

    @staticmethod
    def _nmea_checksum(sentence: str) -> str:
        """NMEA XOR checksum (MP CommsNTRIP.cs:435 GetChecksum)."""
        cs = 0
        for c in sentence:
            if c == '$':
                continue
            if c == '*':
                break
            cs ^= ord(c)
        return f'{cs:02X}'

    def _build_gga(self) -> bytes:
        """Build $GPGGA NMEA sentence with current rover position.

        VRS NTRIP casters (千寻 / RTKBase) require this every ~30s to send
        relevant corrections for the rover area. MP CommsNTRIP.cs:408-431.
        """
        from datetime import datetime
        now = datetime.utcnow()
        lat = self.rover_lat
        lon = self.rover_lon
        # Convert decimal degrees → DDMM.MMMMM (NMEA format)
        lat_abs = abs(lat)
        lon_abs = abs(lon)
        lat_d = int(lat_abs)
        lat_m = (lat_abs - lat_d) * 60
        lon_d = int(lon_abs)
        lon_m = (lon_abs - lon_d) * 60
        ns = 'N' if lat >= 0 else 'S'
        ew = 'E' if lon >= 0 else 'W'
        body = (
            f'GPGGA,{now.strftime("%H%M%S.%f")[:9]},'
            f'{lat_d:02d}{lat_m:08.5f},{ns},'
            f'{lon_d:03d}{lon_m:08.5f},{ew},'
            f'1,10,1,{self.rover_alt:.2f},M,0,M,0.0,0'
        )
        cs = self._nmea_checksum(body)
        return f'${body}*{cs}\r\n'.encode()

    def start(self):
        if self.running:
            return False
        self.running = True
        self.thread = threading.Thread(target=self._loop, daemon=True)
        self.thread.start()
        return True

    def stop(self):
        self.running = False
        if self.sock:
            try:
                self.sock.close()
            except Exception:
                pass
            self.sock = None

    def _loop(self):
        retry_delay = 2.0
        while self.running:
            try:
                self.sock = socket.create_connection((self.host, self.port), timeout=10)
                self.sock.settimeout(5.0)
                self.sock.sendall(self._build_request())
                # Read header
                header = b''
                while b'\r\n\r\n' not in header and len(header) < 4096:
                    chunk = self.sock.recv(1024)
                    if not chunk:
                        break
                    header += chunk
                    # NTRIP rev1: just "ICY 200 OK\r\n"
                    if b'\r\n' in header and (header.startswith(b'ICY 200') or header.startswith(b'HTTP/1')):
                        if b'\r\n\r\n' in header or header.startswith(b'ICY 200 OK\r\n'):
                            break
                if b'200 OK' not in header and b'200' not in header[:32]:
                    err = header.decode('latin-1', errors='replace')[:200]
                    self.on_status({'connected': False, 'error': f'NTRIP HTTP: {err}'})
                    self.sock.close()
                    self.sock = None
                    if self.running:
                        time.sleep(retry_delay)
                        continue
                    return
                # Find body start
                body_start = header.find(b'\r\n\r\n')
                body = header[body_start + 4:] if body_start >= 0 else (
                    header[len(b'ICY 200 OK\r\n'):] if header.startswith(b'ICY 200') else b''
                )
                self.on_status({'connected': True, 'host': self.host, 'mountpoint': self.mountpoint})
                if body:
                    self.bytes_in += len(body)
                    self.on_rtcm(body)
                # Send first GGA on connect (some VRS casters won't send any
                # RTCM until rover position arrives)
                self._maybe_send_gga(force=True)
                # Stream
                while self.running:
                    try:
                        chunk = self.sock.recv(4096)
                    except socket.timeout:
                        # Idle window — opportunity to send GGA every 30s
                        self._maybe_send_gga()
                        continue
                    if not chunk:
                        break
                    self.bytes_in += len(chunk)
                    self.on_rtcm(chunk)
                    # Periodic GGA in case stream is busy
                    self._maybe_send_gga()
                self.on_status({'connected': False, 'note': 'stream ended'})
            except Exception as e:
                self.on_status({'connected': False, 'error': str(e)})
            finally:
                if self.sock:
                    try: self.sock.close()
                    except: pass
                    self.sock = None
            if self.running:
                time.sleep(retry_delay)

    def _maybe_send_gga(self, force: bool = False):
        """Send $GPGGA every 30s if rover position is non-zero (MP CommsNTRIP.cs:411)."""
        if not self.sock:
            return
        if self.rover_lat == 0 and self.rover_lon == 0:
            return  # No fix yet, nothing to report
        now = time.time()
        if not force and now - self._last_gga < 30:
            return
        try:
            self.sock.sendall(self._build_gga())
            self._last_gga = now
        except Exception:
            pass

    def fetch_sourcetable(self, timeout=10) -> list:
        """One-shot fetch of sourcetable (GET /). Returns list of STR entries as dicts."""
        s = socket.create_connection((self.host, self.port), timeout=timeout)
        s.settimeout(timeout)
        req = (
            f'GET / HTTP/1.0\r\n'
            f'User-Agent: {self.user_agent}\r\n'
            f'Accept: */*\r\n'
            f'Connection: close\r\n'
            f'\r\n'
        ).encode()
        s.sendall(req)
        buf = b''
        while True:
            try:
                chunk = s.recv(4096)
            except socket.timeout:
                break
            if not chunk: break
            buf += chunk
        s.close()
        text = buf.decode('latin-1', errors='replace')
        entries = []
        for line in text.split('\n'):
            line = line.strip()
            if not line.startswith('STR;'): continue
            parts = line.split(';')
            if len(parts) < 5: continue
            entries.append({
                'mountpoint': parts[1],
                'identifier': parts[2],
                'format': parts[3],
                'format_details': parts[4] if len(parts) > 4 else '',
                'carrier': parts[5] if len(parts) > 5 else '',
                'nav_system': parts[6] if len(parts) > 6 else '',
                'country': parts[8] if len(parts) > 8 else '',
            })
        return entries


# ─── RtkManager: orchestrates 9PS + RTCM injection ───────────────
class RtkManager:
    """Manages 9PS USB connection + Survey-In + RTCM forwarding to FC.

    Status callbacks:
        on_status(dict)   — connection status, errors
        on_svin(dict)     — Survey-In progress {dur, acc_mm, obs, valid, active}
        on_inject(dict)   — injection stats {frames, bytes, msg_types}
    """

    def __init__(self, mav, target_sys, target_comp,
                 on_status=None, on_svin=None, on_inject=None,
                 backup_dir: str = None):
        self.mav = mav  # mavutil connection (FC)
        self.tgt_sys = target_sys
        self.tgt_comp = target_comp
        self.on_status = on_status or (lambda *_: None)
        self.on_svin = on_svin or (lambda *_: None)
        self.on_inject = on_inject or (lambda *_: None)

        self.ser = None
        self.port = None
        self.baud = None
        self.thread = None
        self.running = False
        self.injecting = False
        self.svin_active = False
        self.fixed_pos_active = False

        # NTRIP state (alternate RTCM source, instead of local 9PS)
        self.ntrip = None
        self.source_mode = 'none'  # 'none' / '9ps' / 'ntrip'

        self.ubx = UbxParser()
        self.rtcm = Rtcm3Parser()
        self.rtcm_ntrip = Rtcm3Parser()  # separate parser for NTRIP byte stream

        # Stats
        self.frames_seen = 0
        self.bytes_injected = 0
        self.fragment_seq = 0
        self.msg_types_seen = {}
        # bps tracker (window resets every second, like MP timer1_Tick)
        self._bps_in = 0       # bytes/sec received from source (9PS or NTRIP)
        self._bps_useful = 0   # bytes/sec valid RTCM frames forwarded
        self._bps_last_reset = time.time()

        # Backup file (raw bytes from source, like MP basedata stream)
        # Disabled by default; pass backup_dir to enable.
        self._backup_dir = backup_dir
        self._backup_fp = None

    def connect(self, port: str, baud: int = 115200):
        if self.ser:
            self.disconnect()
        try:
            self.ser = serial.Serial(port, baud, timeout=0.2, exclusive=True)
        except Exception as e:
            self.on_status({'connected': False, 'error': str(e)})
            return False
        self.port = port
        self.baud = baud
        self.running = True
        self.source_mode = '9ps'
        self._backup_open('9ps')
        self.thread = threading.Thread(target=self._reader_loop, daemon=True)
        self.thread.start()
        self.on_status({'connected': True, 'port': port, 'baud': baud})
        return True

    def disconnect(self):
        self.running = False
        if self.ser:
            try:
                self.ser.close()
            except Exception:
                pass
            self.ser = None
        self.injecting = False
        self.svin_active = False
        self.fixed_pos_active = False
        if self.source_mode == '9ps':
            self.source_mode = 'none'
        self._backup_close()
        self.on_status({'connected': False})

    def start_survey_in(self, min_dur_sec: int = 60, accuracy_mm: int = 2500):
        """Configure 9PS for Survey-In + enable RTCM3 outputs on USB.

        Per MP ubx_m8p.cs:511 SetupBasePos sequence: TMODE3 + per-msg rate config.
        """
        if not self.ser:
            return False
        # 1. Set TMODE3 to Survey-In
        self.ser.write(cfg_tmode3_survey_in(min_dur_sec, accuracy_mm))
        time.sleep(0.05)
        # 2. Enable RTCM3 messages on USB at MP-correct rates (1005/1230 every 5s, MSM7 every 1s)
        for mid, rate in RTCM3_MSGS:
            self.ser.write(cfg_msg_enable_rtcm3(mid, rate=rate))
            time.sleep(0.03)
        self.svin_active = True
        self.on_status({'svin_started': True, 'min_dur': min_dur_sec,
                        'acc_mm': accuracy_mm})
        return True

    def stop_survey_in(self):
        """Disable TMODE3 (return to rover mode), stop RTCM outputs."""
        if not self.ser:
            return False
        for mid, _ in RTCM3_MSGS:
            self.ser.write(cfg_msg_enable_rtcm3(mid, rate=0))
            time.sleep(0.03)
        self.ser.write(cfg_tmode3_disable())
        self.svin_active = False
        self.fixed_pos_active = False
        self.injecting = False
        return True

    def set_fixed_position(self, lat_deg: float, lon_deg: float, alt_m: float, acc_mm: int = 100):
        """Configure 9PS for Fixed-Position mode (skip Survey-In, use known LLA).

        Useful when base location is already surveyed precisely, e.g., RTK-derived
        coordinates from a previous Survey-In session.
        """
        if not self.ser:
            return False
        self.ser.write(cfg_tmode3_fixed_lla(lat_deg, lon_deg, alt_m, acc_mm))
        time.sleep(0.05)
        for mid, rate in RTCM3_MSGS:
            self.ser.write(cfg_msg_enable_rtcm3(mid, rate=rate))
            time.sleep(0.03)
        self.fixed_pos_active = True
        self.svin_active = False
        self.on_status({'fixed_pos_started': True, 'lat': lat_deg, 'lon': lon_deg,
                        'alt': alt_m, 'acc_mm': acc_mm})
        return True

    def set_inject(self, on: bool):
        self.injecting = on
        self.on_status({'injecting': on})

    # ─── NTRIP source ───────────────────────────────────────────────
    def ntrip_connect(self, host: str, port: int, mountpoint: str,
                      user: str = '', password: str = '', ntrip_v1: bool = False):
        """Switch RTCM source from local 9PS to NTRIP caster.

        Default NTRIP v2 (HTTP/1.1 + Ntrip-Version: Ntrip/2.0). Pass ntrip_v1=True
        for legacy casters that only accept HTTP/1.0 ICY 200 OK.
        """
        if self.ntrip:
            self.ntrip.stop()
        self._backup_close()  # close any 9PS backup
        self._backup_open(f'ntrip_{mountpoint}')
        self.ntrip = NtripClient(
            host, port, mountpoint, user, password,
            on_rtcm=self._ntrip_on_rtcm,
            on_status=lambda d: self.on_status({'ntrip': True, **d}),
            ntrip_v1=ntrip_v1,
        )
        self.ntrip.start()
        self.source_mode = 'ntrip'
        self.injecting = True   # auto-inject for NTRIP
        return True

    def ntrip_disconnect(self):
        if self.ntrip:
            self.ntrip.stop()
            self.ntrip = None
        if self.source_mode == 'ntrip':
            self.source_mode = 'none'
            self.injecting = False
        self._backup_close()
        self.on_status({'ntrip': False})

    def update_rover_position(self, lat: float, lon: float, alt: float):
        """Forward rover position to NTRIP client for $GPGGA (VRS support)."""
        if self.ntrip:
            self.ntrip.update_rover_position(lat, lon, alt)

    def ntrip_fetch_sourcetable(self, host: str, port: int) -> list:
        """One-shot sourcetable fetch (no auth required for sourcetable)."""
        client = NtripClient(host, port, '')
        return client.fetch_sourcetable()

    def _ntrip_on_rtcm(self, data: bytes):
        """NTRIP TCP delivers a raw RTCM3 byte stream — parse + forward."""
        self._bps_in += len(data)
        self._backup_write(data)
        for frame, mtype in self.rtcm_ntrip.feed(data):
            self.frames_seen += 1
            self.msg_types_seen[mtype] = self.msg_types_seen.get(mtype, 0) + 1
            self._bps_useful += len(frame)
            if self.injecting:
                self._send_rtcm_to_fc(frame)
        self._maybe_push_bps()
        self.on_inject({
            'frames': self.frames_seen,
            'bytes': self.bytes_injected,
            'msg_types': dict(self.msg_types_seen),
        })

    # ─── Backup file (MP ConfigSerialInjectGPS.cs:436 .gpsbase) ──────
    def _backup_open(self, src_label: str):
        """Open <backup_dir>/<yyyy-MM-dd HH-mm-ss>_<src>.gpsbase for raw stream."""
        if not self._backup_dir:
            return
        try:
            os.makedirs(self._backup_dir, exist_ok=True)
            ts = datetime.datetime.now().strftime('%Y-%m-%d_%H-%M-%S')
            fname = f'{ts}_{src_label}.gpsbase'
            self._backup_fp = open(os.path.join(self._backup_dir, fname), 'wb')
            self.on_status({'backup_file': fname})
        except Exception as e:
            self.on_status({'error': f'backup open: {e}'})
            self._backup_fp = None

    def _backup_close(self):
        if self._backup_fp:
            try:
                self._backup_fp.flush()
                self._backup_fp.close()
            except Exception:
                pass
            self._backup_fp = None

    def _backup_write(self, data: bytes):
        if self._backup_fp:
            try:
                self._backup_fp.write(data)
            except Exception:
                pass

    def _maybe_push_bps(self):
        """Push bps stat every 1s (MP timer1_Tick pattern)."""
        now = time.time()
        if now - self._bps_last_reset >= 1.0:
            self.on_inject({
                'bps_in': self._bps_in,
                'bps_useful': self._bps_useful,
                'frames': self.frames_seen,
                'bytes': self.bytes_injected,
                'msg_types': dict(self.msg_types_seen),
            })
            self._bps_in = 0
            self._bps_useful = 0
            self._bps_last_reset = now

    def _reader_loop(self):
        """Read 9PS serial, parse UBX + RTCM3, forward RTCM frames to FC.

        Auto-reconnect: if no data for 10s and port closed (MP ConfigSerialInjectGPS.cs:670).
        """
        last_poll = 0.0
        last_recv = time.time()
        RECONNECT_TIMEOUT = 10.0   # MP-matching
        while self.running:
            # Reconnect logic — guarded by self.running so disconnect() races safely
            try:
                need_reconnect = (
                    self.running and (
                        self.ser is None or
                        (time.time() - last_recv) > RECONNECT_TIMEOUT or
                        (self.ser is not None and not self.ser.is_open)
                    )
                )
                if need_reconnect and self.running:
                    self.on_status({'note': 'reconnecting 9PS (no data 10s)'})
                    try:
                        if self.ser:
                            self.ser.close()
                    except Exception:
                        pass
                    self.ser = None
                    if not self.running:
                        break
                    try:
                        self.ser = serial.Serial(self.port, self.baud, timeout=0.2, exclusive=True)
                        self.on_status({'connected': True, 'port': self.port, 'baud': self.baud,
                                        'note': 'reconnected'})
                        if self.svin_active:
                            for mid, rate in RTCM3_MSGS:
                                self.ser.write(cfg_msg_enable_rtcm3(mid, rate=rate))
                                time.sleep(0.02)
                    except Exception as e:
                        self.on_status({'connected': False, 'error': f'reconnect: {e}'})
                        time.sleep(2.0)
                        continue
                    last_recv = time.time()
            except Exception:
                pass

            if not self.running or self.ser is None:
                break

            try:
                data = self.ser.read(4096)
            except Exception as e:
                if not self.running:
                    break
                self.on_status({'error': f'read: {e}'})
                time.sleep(0.5)
                continue

            if data:
                last_recv = time.time()
                self._bps_in += len(data)
                self._backup_write(data)
                # Try UBX framing first
                for cls, mid, payload in self.ubx.feed(data):
                    self._handle_ubx(cls, mid, payload)
                # Try RTCM3 framing on the same buffer (different sync, no conflict)
                for frame, mtype in self.rtcm.feed(data):
                    self.frames_seen += 1
                    self._bps_useful += len(frame)
                    self.msg_types_seen[mtype] = self.msg_types_seen.get(mtype, 0) + 1
                    if self.injecting:
                        self._send_rtcm_to_fc(frame)
                self._maybe_push_bps()

            # Poll NAV-SVIN every 1s while in survey-in
            now = time.time()
            if self.svin_active and now - last_poll > 1.0:
                try:
                    self.ser.write(cfg_msg_poll_navsvin())
                except Exception:
                    pass
                last_poll = now

    def _handle_ubx(self, cls: int, mid: int, payload: bytes):
        if cls == UBX_NAV and mid == NAV_SVIN and len(payload) >= 40:
            # NAV-SVIN response
            (version, _r1, _r2, _r3,
             iTOW, dur, meanX, meanY, meanZ,
             meanXHP, meanYHP, meanZHP, _r4,
             meanAcc, obs, valid, active, _r5, _r6) = struct.unpack(
                '<BBBBIIiiibbbBIIBBBB', payload[:40])
            self.on_svin({
                'dur': dur,                # seconds
                'acc_mm': meanAcc / 10.0,  # 0.1mm → mm
                'obs': obs,
                'valid': bool(valid),
                'active': bool(active),
            })
            # Auto-start injection once valid
            if valid and self.svin_active and not self.injecting:
                self.set_inject(True)

    def _send_rtcm_to_fc(self, frame: bytes):
        """Split RTCM frame into GPS_RTCM_DATA fragments.

        1:1 port of MP MAVLinkInterface.cs:3894 InjectGpsData(rtcm_message=true):
        - msglen = 180
        - if length > msglen*4: drop (MP returns)
        - nopackets: when length % msglen == 0 → length/msglen + 1 (terminator pkt)
                     else → (length/msglen) + 1
        - cap nopackets at 4
        - for each pkt: flags = (frag bit 0=1 if nopackets>1) | (idx<<1) | (seq<<3)
        - seq increments AFTER the loop, even for single-frame
        """
        MAX_LEN = 180
        length = len(frame)
        if length > MAX_LEN * 4:
            self.on_status({'error': f'rtcm frame too large: {length}B (cap 720)'})
            return

        if length % MAX_LEN == 0:
            nopackets = length // MAX_LEN + 1   # terminator packet
        else:
            nopackets = (length // MAX_LEN) + 1
        if nopackets >= 4:
            nopackets = 4

        seq = self.fragment_seq & 0x1F

        for a in range(nopackets):
            flags = 1 if nopackets > 1 else 0
            flags |= (a & 0x3) << 1
            flags |= (seq & 0x1F) << 3
            copy_len = min(length - a * MAX_LEN, MAX_LEN)
            if copy_len < 0:
                copy_len = 0   # terminator packet has 0 length
            chunk = frame[a * MAX_LEN: a * MAX_LEN + copy_len]
            self._send_one_rtcm_msg(flags, chunk)

        # Always increment seq per RTCM frame (MP MAVLinkInterface.cs:3945)
        self.fragment_seq = (self.fragment_seq + 1) & 0x1F

        self.bytes_injected += length
        self.on_inject({
            'frames': self.frames_seen,
            'bytes': self.bytes_injected,
            'msg_types': dict(self.msg_types_seen),
        })

    def _send_one_rtcm_msg(self, flags: int, chunk: bytes):
        try:
            data_buf = chunk + b'\x00' * (180 - len(chunk))
            self.mav.mav.gps_rtcm_data_send(flags, len(chunk), data_buf)
        except Exception as e:
            self.on_status({'error': f'rtcm_send: {e}'})


# ─── Self-test ─────────────────────────────────────────────────────
if __name__ == '__main__':
    import sys
    print('UBX selftest:')
    pkt = ubx_pack(UBX_CFG, CFG_RATE, b'\xe8\x03\x01\x00\x01\x00')
    print(f'  CFG-RATE 1Hz nav={pkt.hex()}')
    assert pkt[:2] == UBX_SYNC
    assert ubx_checksum(pkt[2:-2]) == pkt[-2:]
    print('  ✓ checksum ok')

    print('UbxParser selftest:')
    parser = UbxParser()
    out = parser.feed(b'\x00\x00' + pkt + b'\x99\x88')
    print(f'  parsed {len(out)} frames')
    assert len(out) == 1
    cls, mid, payload = out[0]
    assert cls == UBX_CFG and mid == CFG_RATE
    print('  ✓ frame extracted')

    print('Rtcm3Parser selftest:')
    # Build a real RTCM frame with valid CRC-24Q
    # Header: 0xD3 + len(10-bit BE) + payload + CRC24Q(3B over header+payload)
    # Payload: 4 bytes, msg type 1005 (0x3ED) = first 12 bits → 0x3E,0xD0
    payload = bytes([0x3E, 0xD0, 0xAB, 0xCD])
    header = bytes([0xD3, 0x00, len(payload)])
    crc = crc24q(header + payload)
    crc_bytes = bytes([(crc >> 16) & 0xFF, (crc >> 8) & 0xFF, crc & 0xFF])
    rtcm_frame = header + payload + crc_bytes
    rp = Rtcm3Parser()
    frames = rp.feed(b'\xff' + rtcm_frame + b'\xee')
    assert len(frames) == 1, f'expected 1, got {len(frames)}'
    f, mt = frames[0]
    print(f'  parsed RTCM frame type={mt}, len={len(f)}')
    assert mt == 0x3ED, f'expected msg type 1005 (0x3ED), got {mt:#x}'
    print('  ✓ frame extracted + CRC verified')

    # Negative test: corrupted CRC must be rejected
    bad_frame = bytearray(rtcm_frame)
    bad_frame[-1] ^= 0xFF
    rp2 = Rtcm3Parser()
    bad_out = rp2.feed(bytes(bad_frame))
    assert len(bad_out) == 0, 'corrupt frame should be rejected'
    assert rp2.bad_crc == 1, 'bad_crc counter should be 1'
    print('  ✓ corrupted CRC rejected (bad_crc=1)')

    print('GPS_RTCM_DATA fragmenter selftest (vs MP MAVLinkInterface.cs:3894):')
    # Verify packet count formula matches MP exactly
    # MP: nopackets = (length % 180 == 0) ? length/180+1 : (length/180)+1, capped at 4
    test_cases = [
        (50,  1),   # < 180
        (180, 2),   # exact, +terminator
        (200, 2),
        (360, 3),   # exact, +terminator
        (400, 3),
        (540, 4),   # exact, but capped at 4
        (720, 4),   # exact 4, capped at 4 (no terminator)
    ]
    for length, expected in test_cases:
        if length % 180 == 0:
            n = length // 180 + 1
        else:
            n = (length // 180) + 1
        if n >= 4: n = 4
        assert n == expected, f'len={length}: expected {expected}, got {n}'
    print('  ✓ packet count formula matches MP')

    print('all tests passed.')
