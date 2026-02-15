"""Text post-processing for AI replies: bubble splitting, casual noise, location filtering."""
import re
import random


def _split_sentences(raw):
    return [s.strip() for s in re.split(r"(?<=[\.\!\?…])\s+", raw) if s.strip()]


def _finish_punct(s):
    s = s.strip()
    if not s:
        return s
    if s[-1] in ".!?…":
        return s if s[-1] != "…" else s[:-1] + "."
    return s + "."


def enforce_bubbles(text, max_bubbles=3):
    """Split long text into natural bubble boundaries using '|||'."""
    if "|||" in text:
        return text
    raw = text.strip()
    if not raw:
        return raw
    desired = random.choices([2, 1, 3], weights=[45, 35, 20], k=1)[0]
    desired = max(1, min(desired, max_bubbles))
    sents = _split_sentences(raw)
    if not sents or len(raw) < 30:
        return _finish_punct(raw)
    approx = max(1, len(raw) // desired)
    parts = []
    start = 0
    for _ in range(desired - 1):
        end = min(len(raw), start + approx)
        ws = raw.rfind(" ", start, min(len(raw), end + 20))
        cut = ws if ws != -1 and ws > start + 5 else end
        parts.append(_finish_punct(raw[start:cut].strip()))
        start = cut
    parts.append(_finish_punct(raw[start:].strip()))
    parts = [p for p in parts if p]
    return "|||".join(parts[:desired])


def normalize_bubbles_final(text, max_bubbles=3):
    """Merge excess bubbles and ensure punctuation on each."""
    parts = [p.strip() for p in text.split("|||") if p.strip()]
    if not parts:
        return ""
    if len(parts) > max_bubbles:
        merged = parts[:max_bubbles - 1]
        rest = " ".join(parts[max_bubbles - 1:])
        merged.append(_finish_punct(rest))
        parts = merged
    parts = [_finish_punct(p) for p in parts]
    return "|||".join(parts)


def apply_casual_noise(text, prob=0.20):
    """Randomly apply casual text transformations (lowercase, abbreviations)."""
    if prob <= 0:
        return text
    parts = text.split("|||")
    new_parts = []
    for p in parts:
        s = p.strip()
        if not s:
            new_parts.append(s)
            continue
        if random.random() < prob:
            choice = random.choice(["lower_start", "drop_comma", "abbr"])
            if choice == "lower_start" and s:
                s = s[0:1].lower() + s[1:]
            elif choice == "drop_comma":
                s = re.sub(r",\s+", " ", s, count=1)
            elif choice == "abbr":
                repls = [
                    (r"\bokay\b", "ok"),
                    (r"\bVielleicht\b", "Vllt"),
                    (r"\bvielleicht\b", "vllt"),
                    (r"\bein bisschen\b", "n bisschen"),
                    (r"\bbisschen\b", "bissl"),
                ]
                for pat, rep in repls:
                    if re.search(pat, s, flags=re.IGNORECASE):
                        s = re.sub(pat, rep, s, flags=re.IGNORECASE, count=1)
                        break
        new_parts.append(s)
    return "|||".join(new_parts)


def enforce_near_user_filters(text, location_mode):
    """Replace explicit city mentions with vague location when mode is near_user."""
    if location_mode != "near_user":
        return text
    replacement = ("ich wohn so 20\u201330 min von dir entfernt, "
                   "kleine stadt bei dir um die ecke. "
                   "M\u00f6chte es aber erstmal f\u00fcr mich behalten, ja?")
    patterns = [
        r"\bich\s+komme\s+aus\s+[A-Z\u00c4\u00d6\u00dc][A-Za-z\u00c4\u00d6\u00dc\u00e4\u00f6\u00fc\u00df\- ]{2,}",
        r"\bich\s+bin\s+aus\s+[A-Z\u00c4\u00d6\u00dc][A-Za-z\u00c4\u00d6\u00dc\u00e4\u00f6\u00fc\u00df\- ]{2,}",
        r"\bich\s+wohne\s+(?:in|bei)\s+[A-Z\u00c4\u00d6\u00dc][A-Za-z\u00c4\u00d6\u00dc\u00e4\u00f6\u00fc\u00df\- ]{2,}",
        r"\bwohn[e]?\s+in\s+[A-Z\u00c4\u00d6\u00dc][A-Za-z\u00c4\u00d6\u00dc\u00e4\u00f6\u00fc\u00df\- ]{2,}",
    ]
    out = text
    for pat in patterns:
        out = re.sub(pat, replacement, out, flags=re.IGNORECASE)
    out = re.sub(
        r"\baus\s+[A-Z\u00c4\u00d6\u00dc][A-Za-z\u00c4\u00d6\u00dc\u00e4\u00f6\u00fc\u00df\- ]{2,}",
        "aus der N\u00e4he", out
    )
    return out
