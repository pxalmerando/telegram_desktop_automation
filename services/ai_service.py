import json
import copy
import time
import logging
import requests
from datetime import datetime
from database import SessionLocal
from models import (AIConfig, AIAutoReplyAccount,
                    TelegramProfile, TelegramProfileAccount)
import cache
from services.text_processing import (
    enforce_bubbles, normalize_bubbles_final,
    apply_casual_noise, enforce_near_user_filters,
)

logger = logging.getLogger(__name__)

_cached_config = None
_cached_config_time = 0
_CONFIG_CACHE_TTL = 30

DEFAULT_SETTINGS = {
    "FLIRT_LEVEL": "hardcore",
    "LOCATION_MODE": "near_user",
    "TEMPERATURE": 0.5,
    "MAX_BUBBLES": 3,
    "MAX_CHARS_PER_BUBBLE": 999,
    "BUBBLE_DELAY_RANGE_S": [5.0, 8.0],
    "TIMEZONE": "Europe/Berlin",
    "PHOTO_MODE": "percent",
    "PHOTO_PERCENT": 0.7,
    "PHOTO_CAPTION": "",
    "PHOTO_CAPTIONS": [
        "\u270c\ufe0f",
        "hoffe, ich gefall dir \ud83d\ude07",
        "bisschen spontan\u2026",
        "hier was aktuelles",
        "bin gespannt was du sagst \ud83d\ude05",
        "nur f\u00fcr dich \ud83d\ude09"
    ],
    "ON_DEMAND_PHOTO_CAPTION": "ok, hier \ud83d\ude0a",
    "FIRST_ASK_ORIGIN": True,
    "FIRST_ASK_TEXT": "Hey, sch\u00f6n dass du mir geschrieben hast, wie hei\u00dft du? \ud83d\ude18 \ud83d\ude18",
    "MODEL_NAME": "grok-4-fast-non-reasoning",
    "ALLOW_QUESTIONS_PROB": 0.0,
    "ENABLE_MISMATCH_CLASSIFIER": True,
    "NAMECARD": {
        "enabled": True,
        "template_path": "template.png",
        "date_format_linux": "%-d.%-m.%y",
        "date_format_windows": "%#d.%#m.%y",
        "placeholder": "__PERSONALIZED__",
        "late_send": "next_media_slot",
        "caption": "nur f\u00fcr dich, {name} \ud83d\ude09",
    },
    "FINAL_MESSAGES": [
        "hier nochmal die seite {domain} \ud83d\ude18",
        "hier damit du mir glaubst, das ich echt bin\ud83d\ude18 - hoffe du siehst es noch...",
    ],
    "MISMATCH_REPLY": "Ich hatte bei Lovoo die Bilder von meiner Freundin drinnen, wollte bisschen anonym bleiben \u2013 aber das hier bin ich.\ud83d\ude18",
    "CTA": {
        "enabled": True,
        "start_mode": "absolute",
        "start_at": 20,
        "start_ratio": 1.0,
        "start_delay_range_s": [650, 800],
        "step_delay_range_s": [300, 600],
        "vars": {"domain": "fast-verliebt.de", "username": "Linea"},
        "steps": [
            {"type": "text", "content": "Hmm shit.. deine nachricht wird mir nicht mehr angezeigt ich sehe nur das du mir geschrieben hast aber kann sie nicht sehen..."},
            {"type": "image", "filename": "__LAST__", "caption": "Diese Meldung wird mir auf jeden Fall angezeigt... hast du noch was geschrieben?... versuchs mal nochmal bitte... will jetzt nicht aufh\u00f6ren bin gerade so geil..."},
            {"type": "text", "content": "ich hab\u2019s nochmal getestet... \ud83d\ude44 telegram blockt mich irgendwie vielleicht weil wir so pervers schreiben haha, ich seh deine nachrichten nicht mehr, aber du meine hoffentlich. ich will dich so dringend treffen und den ganzen tag hart ficken! \u2013 schreib mir sonst auf {domain} , ich bin da als {username}, und dann gucken wir, wo weiter schreiben k\u00f6nnen \ud83d\ude18"},
            {"type": "text", "content": "Hier nochmal die Seite {domain} \ud83d\ude18"},
        ],
        "sync_start_to_message_limit": True,
    },
}

# Backward compat alias — points to the same defaults inside settings
DEFAULT_CTA = DEFAULT_SETTINGS["CTA"]


class AIService:

    def get_config(self):
        global _cached_config, _cached_config_time
        now = time.time()
        if _cached_config is not None and (now - _cached_config_time) < _CONFIG_CACHE_TTL:
            return _cached_config
        try:
            config = AIConfig.query.first()
            if config:
                # Eagerly load account IDs before session detaches
                config._selected_account_ids = [
                    sa.account_id for sa in config.selected_accounts.all()
                ]
            _cached_config = config
            _cached_config_time = now
            return config
        finally:
            SessionLocal.remove()

    def get_config_dict(self):
        config = self.get_config()
        if not config:
            return {
                'provider': 'openai', 'api_key': '', 'model': 'gpt-4o-mini',
                'system_prompt': '', 'auto_reply_enabled': False,
                'auto_reply_scope': 'all', 'max_tokens': 500,
                'temperature': 0.7, 'selected_account_ids': []
            }
        return config.to_dict()

    def save_config(self, provider, api_key, model, system_prompt,
                    auto_reply_enabled, auto_reply_scope, account_ids,
                    max_tokens=500, temperature=0.7):
        global _cached_config, _cached_config_time
        try:
            config = AIConfig.query.first()
            if not config:
                config = AIConfig()
                SessionLocal.add(config)

            config.provider = provider
            if api_key and '...' not in api_key and api_key != '****':
                config.api_key = api_key
            config.model = model
            config.system_prompt = system_prompt
            config.auto_reply_enabled = auto_reply_enabled
            config.auto_reply_scope = auto_reply_scope
            config.max_tokens = max_tokens
            config.temperature = temperature

            AIAutoReplyAccount.query.filter_by(config_id=config.id).delete()
            SessionLocal.flush()
            if auto_reply_scope == 'selected' and account_ids:
                for acc_id in account_ids:
                    SessionLocal.add(AIAutoReplyAccount(config_id=config.id, account_id=acc_id))

            SessionLocal.commit()
            # Eagerly cache account IDs before session detaches
            config._selected_account_ids = list(account_ids) if account_ids else []
            _cached_config = None
            _cached_config_time = 0
            cache.cache_delete('ai:auto_reply_enabled:*')
            result = config.to_dict()
            result['success'] = True
            return result
        finally:
            SessionLocal.remove()

    def is_auto_reply_enabled_for(self, account_id):
        cache_key = f'ai:auto_reply_enabled:{account_id}'
        cached = cache.cache_get(cache_key)
        if cached is not None:
            return cached

        config = self.get_config()
        if not config or not config.auto_reply_enabled or not config.api_key:
            result = False
        elif config.auto_reply_scope == 'all':
            result = True
        else:
            try:
                result = AIAutoReplyAccount.query.filter_by(
                    config_id=config.id, account_id=account_id
                ).first() is not None
            finally:
                SessionLocal.remove()

        cache.cache_set(cache_key, result, ttl=300)
        return result

    def get_conversation_history(self, account_id, chat_id, limit=10):
        raw_msgs = cache.get_chat_msgs(account_id, chat_id, limit)
        if not raw_msgs:
            return []
        history = []
        for msg in reversed(raw_msgs):
            text = msg.get('text')
            if not text:
                continue
            role = 'user' if msg.get('is_incoming') else 'assistant'
            entry = {'role': role, 'content': text}
            sender = msg.get('sender_name')
            if sender:
                entry['sender'] = sender
            history.append(entry)
        return history

    # ==================== PROFILES ====================

    def get_profiles(self):
        try:
            return [p.to_dict() for p in TelegramProfile.query.order_by(TelegramProfile.name).all()]
        finally:
            SessionLocal.remove()

    def get_profile(self, profile_id):
        try:
            return TelegramProfile.query.get(profile_id)
        finally:
            SessionLocal.remove()

    def create_profile(self, data):
        try:
            profile = TelegramProfile(
                name=data['name'], username=data['username'],
                age=data.get('age'), city=data.get('city'),
                job=data.get('job'), hobbies=data.get('hobbies'),
                flirt_level=data.get('flirt_level', 'hot'),
                location_mode=data.get('location_mode', 'fixed'),
                is_active=data.get('is_active', True),
                settings_json=json.dumps(data['settings']) if data.get('settings') else None,
                cta_json=json.dumps(data['cta']) if data.get('cta') else None,
            )
            SessionLocal.add(profile)
            SessionLocal.flush()
            for aid in data.get('account_ids', []):
                SessionLocal.add(TelegramProfileAccount(profile_id=profile.id, account_id=aid))
            SessionLocal.commit()
            cache.cache_delete('ai:profile_for_account:*')
            return profile.to_dict()
        finally:
            SessionLocal.remove()

    def update_profile(self, profile_id, data):
        try:
            profile = TelegramProfile.query.get(profile_id)
            if not profile:
                return {'error': 'Profile not found'}
            for field in ('name', 'username', 'age', 'city', 'job', 'hobbies',
                          'flirt_level', 'location_mode', 'is_active'):
                if field in data:
                    setattr(profile, field, data[field])
            if 'settings' in data:
                profile.settings_json = json.dumps(data['settings']) if data['settings'] else None
            if 'cta' in data:
                profile.cta_json = json.dumps(data['cta']) if data['cta'] else None
            TelegramProfileAccount.query.filter_by(profile_id=profile_id).delete()
            for aid in data.get('account_ids', []):
                SessionLocal.add(TelegramProfileAccount(profile_id=profile_id, account_id=aid))
            SessionLocal.commit()
            cache.cache_delete('ai:profile_for_account:*')
            return profile.to_dict()
        finally:
            SessionLocal.remove()

    def delete_profile(self, profile_id):
        try:
            profile = TelegramProfile.query.get(profile_id)
            if not profile:
                return {'error': 'Profile not found'}
            SessionLocal.delete(profile)
            SessionLocal.commit()
            cache.cache_delete('ai:profile_for_account:*')
            return {'success': True}
        finally:
            SessionLocal.remove()

    def get_profile_for_account(self, account_id):
        cache_key = f'ai:profile_for_account:{account_id}'
        cached = cache.cache_get(cache_key)
        if cached is not None:
            if cached == '__none__':
                return None
            try:
                return TelegramProfile.query.get(cached)
            finally:
                SessionLocal.remove()

        try:
            mapping = TelegramProfileAccount.query.filter_by(account_id=account_id).first()
            if mapping:
                profile = TelegramProfile.query.get(mapping.profile_id)
                cache.cache_set(cache_key, mapping.profile_id, ttl=300)
                return profile
            cache.cache_set(cache_key, '__none__', ttl=300)
            return None
        finally:
            SessionLocal.remove()

    def get_profile_settings(self, profile):
        merged = copy.deepcopy(DEFAULT_SETTINGS)
        if profile and profile.settings_json:
            try:
                overrides = json.loads(profile.settings_json)
                for k, v in overrides.items():
                    if k in ('NAMECARD', 'CTA') and isinstance(v, dict):
                        merged[k].update(v)
                    else:
                        merged[k] = v
            except Exception:
                pass
        # Backward compat: merge legacy cta_json into settings['CTA']
        if profile and profile.cta_json:
            try:
                cta_overrides = json.loads(profile.cta_json)
                for k, v in cta_overrides.items():
                    merged['CTA'][k] = v
            except Exception:
                pass
        if profile:
            merged['FLIRT_LEVEL'] = profile.flirt_level or merged['FLIRT_LEVEL']
            merged['LOCATION_MODE'] = profile.location_mode or merged['LOCATION_MODE']
            # Auto-sync username into CTA vars if still default
            if merged['CTA']['vars'].get('username') == DEFAULT_CTA['vars']['username']:
                merged['CTA']['vars']['username'] = profile.username
        return merged

    def get_profile_cta(self, profile):
        """Convenience accessor — returns settings['CTA'] (all CTA config lives in settings now)."""
        settings = self.get_profile_settings(profile)
        return settings['CTA']

    @staticmethod
    def substitute_cta_vars(text, vars_dict, name=''):
        result = text
        for k, v in vars_dict.items():
            result = result.replace('{' + k + '}', str(v))
        if name:
            result = result.replace('{name}', name)
        return result

    def build_system_prompt(self, profile, ask_name_hint=""):
        username = profile.username
        age = profile.age or '24'
        city = profile.city or 'Berlin'
        job = profile.job or 'im Einzelhandel'
        flirt = profile.flirt_level or 'hot'
        loc_mode = profile.location_mode or 'fixed'

        if loc_mode == 'fixed':
            location_intro = f"du lebst in/bei {city}."
            location_rules = f"""STANDORT-LOGIK:
- Du sagst offen, dass du aus {city} kommst.
- Wenn er nach deinem Ort fragt, antworte mit {city} oder "aus der N\u00e4he von {city}".
- Du erfindest KEINE anderen St\u00e4dte oder Umz\u00fcge."""
        elif loc_mode == 'near_user':
            location_intro = "du lebst in einer kleineren Stadt in der N\u00e4he von ihm."
            location_rules = """STANDORT-LOGIK:
- Du nennst DEINE Stadt NICHT konkret.
- Wenn er seinen Ort nennt oder fragt wo du wohnst:
  - sag Dinge wie "ich wohn so 20\u201330 min von dir entfernt, kleine stadt bei dir um die ecke. M\u00f6chte es aber erstmal f\u00fcr mich behalten, ja?".
- Wenn er GENAU nach dem Stadtnamen fragt:
  - sag, dass du das hier nicht so genau schreiben magst (Privatsph\u00e4re), bleib vage: "kleine stadt bei dir um die ecke".
- Du nennst NIE einen konkreten Stadtnamen.
- Keine \u201emittlerweile X & davor Y\u201c-Geschichten.
- Wenn er seine Stadt nicht erw\u00e4hnt und darauf nicht eingeht, dann schreib auch nichts mehr dar\u00fcber und mach wie gewohnt weiter."""
        else:
            location_intro = "du lebst in einer kleineren Stadt in seiner N\u00e4he."
            location_rules = """STANDORT-LOGIK:
- Am Anfang nur "aus der N\u00e4he".
- Bei Nachfragen: "so 20-30 min entfernt", "kleine stadt bei dir um die ecke. Wie hei\u00dft du denn eigentlich?".
- Keine exakten St\u00e4dte/Adressen nennen."""

        now = datetime.now()
        hour = now.hour
        if 5 <= hour < 12:
            time_ctx = "morgens"
        elif 12 <= hour < 17:
            time_ctx = "nachmittags"
        elif 17 <= hour < 21:
            time_ctx = "abends"
        else:
            time_ctx = "nachts"
        time_str = now.strftime('%H:%M') + f" ({time_ctx})"

        prompt = f"""du spielst eine frau namens {username}, {age} jahre alt, du arbeitest {job} und {location_intro}
du schreibst mit einem mann auf telegram und m\u00f6chtest ihn kennenlernen; das ist euer erster kontakt \u2013 aber es eskaliert schnell zu geilen, intimen sachen.
aktuelle zeit (system): {time_str}
{ask_name_hint}
ziele:
- locker, menschlich, extrem versaut & explizit (modus: {flirt}); detaillierte sex-szenen, dirty talk, sensorische beschreibungen (z.b. wie feucht du wirst, ger\u00e4usche, empfindungen).
- direkt auf sein thema antworten; **kein interview** \u2013 baue auf seinen inputs auf, mach\u2019s geiler, lass ihn leiten.
- er hat dich angeschrieben; du l\u00e4sst ihn das gespr\u00e4ch f\u00fchren, aber mirror mit geilheit (z.b. "das klingt hot, ich stell mir vor...").
- mehrere kurze nachrichten von ihm: **alle** relevanten inhalte zusammen beantworten.
- bei skepsis zu bildern/identit\u00e4t **genau einmal** kurz & locker: "ich hatte bei lovoo die bilder von meiner freundin drin \u2026 wollte anonym bleiben, aber das hier bin ich \ud83d\ude07". danach nur noch knapp verweisen: "hab ich schon gesagt".
- **reaktion auf bilder:**
  - wenn der nutzer **ein foto gesendet hat**, darfst du auf das bild reagieren, z. b.:
    - "geiles bild \ud83d\ude0f", "puhh gef\u00e4llt mir", "du siehst echt gut aus", "du gef\u00e4llst mir" usw.
    - reagiere mit 1\u20132 kurzen, authentischen s\u00e4tzen (nicht \u00fcbertrieben).
  - wenn der nutzer **kein foto gesendet hat**,
    **darfst du NICHT \u00fcber sein aussehen, seine fotos oder sein k\u00f6rperliches erscheinungsbild sprechen.**
    stattdessen bleib allgemein (z. b. "haha klingt spannend", "mag deine art", "find ich s\u00fc\u00df wie du schreibst").
- **treffen-regel:**
  - wenn der nutzer fragt, **wann** ihr euch treffen k\u00f6nnt oder **vorschl\u00e4gt, sich heute / jetzt zu treffen**,
    dann antworte **niemals mit "heute", "jetzt" oder "sofort"**.
  - sag stattdessen locker und flirty, dass du **in den n\u00e4chsten Tagen** Lust h\u00e4ttest,
    z. b.: "haha nicht heute, aber in paar tagen w\u00e4r cool \ud83d\ude0f"
  - du darfst dabei andeuten, dass du neugierig bist, aber **nicht sofort verf\u00fcgbar**.
stil:
- **kleinschreibung** durchgehend, alltagssprache, kleine tippfehler ok, mische mit dirty talk.
- **kurz halten: 1\u20133 s\u00e4tze insgesamt**, nat\u00fcrliche telegram-bubbles (delimiter: "|||").
- 1\u20132 emojis max., nicht in jeder bubble (z.b. \ud83d\ude08, \ud83d\udca6, \ud83d\ude1c, \ud83d\ude18, \ud83e\udd75).
- **keine** akademische sprache.
fragen-policy (streng, hat vorrang):
- **keine initiativ-fragen.**
- **nur wenn der nutzer vorher eine frage gestellt hat**: zuerst klar beantworten und **optional (70% chance)** eine sehr kurze spiegel-gegenfrage ("und du?"). sonst **keine** frage.
- **nie** zwei antworten hintereinander mit frage enden.
selbst-check VOR dem senden:
- pr\u00fcfe die letzte nutzer-nachricht:
  - wenn sie **kein** '?' enth\u00e4lt: **entferne alle '?'** aus deiner antwort und formuliere als aussage.
  - wenn sie **ein** '?' enth\u00e4lt: erlaube h\u00f6chstens **ein** '?' in deiner antwort.
{location_rules}
antwortformat:
- gib **nur** die chat-antwort zur\u00fcck (ggf. mit "|||")."""
        return prompt

    # ==================== GENERATE REPLY ====================

    def generate_reply(self, incoming_text, system_prompt=None, conversation_history=None, account_id=None):
        config = self.get_config()
        if not config or not config.api_key:
            return {'success': False, 'error': 'AI not configured'}

        profile = None
        profile_settings = None
        model_override = None
        temp_override = None

        if account_id:
            profile = self.get_profile_for_account(account_id)
            if profile:
                profile_settings = self.get_profile_settings(profile)
                model_override = profile_settings.get('MODEL_NAME')
                temp_override = profile_settings.get('TEMPERATURE')

        if system_prompt:
            prompt = system_prompt
        elif profile:
            prompt = self.build_system_prompt(profile)
        else:
            prompt = config.system_prompt or ''

        history = conversation_history or []
        if history:
            user_message = (
                "Verlauf:\n"
                + json.dumps(history, ensure_ascii=False, indent=2)
                + "\n\nLetzte User-Nachricht(en): " + incoming_text
            )
        else:
            user_message = incoming_text

        use_model = model_override or config.model
        use_temp = temp_override if temp_override is not None else config.temperature
        use_max_tokens = config.max_tokens

        try:
            if config.provider == 'anthropic':
                result = self._call_anthropic_raw(
                    config.api_key, use_model or 'claude-sonnet-4-5-20250929',
                    prompt, user_message, [], use_max_tokens, use_temp)
            elif config.provider == 'grok':
                result = self._call_grok_raw(
                    config.api_key, use_model or 'grok-4-fast-non-reasoning',
                    prompt, user_message, [], use_max_tokens, use_temp)
            else:
                result = self._call_openai_raw(
                    config.api_key, use_model or 'gpt-4o-mini',
                    prompt, user_message, [], use_max_tokens, use_temp)
        except Exception as e:
            logger.error(f"AI generate_reply error: {e}")
            return {'success': False, 'error': str(e)}

        # Apply text post-processing to AI reply
        if result.get('success') and result.get('reply'):
            settings = profile_settings or DEFAULT_SETTINGS
            max_bubbles = settings.get('MAX_BUBBLES', 3)
            loc_mode = settings.get('LOCATION_MODE', 'fixed')
            reply = result['reply']
            reply = enforce_bubbles(reply, max_bubbles)
            reply = enforce_near_user_filters(reply, loc_mode)
            reply = apply_casual_noise(reply)
            reply = normalize_bubbles_final(reply, max_bubbles)
            result['reply'] = reply

        return result

    def test_prompt(self, provider, api_key, model, system_prompt, test_message,
                    history=None, temperature=None):
        kwargs = {}
        if temperature is not None:
            kwargs['temperature'] = temperature
        try:
            if provider == 'anthropic':
                return self._call_anthropic_raw(api_key, model, system_prompt, test_message, history, **kwargs)
            elif provider == 'grok':
                return self._call_grok_raw(api_key, model, system_prompt, test_message, history, **kwargs)
            else:
                return self._call_openai_raw(api_key, model, system_prompt, test_message, history, **kwargs)
        except Exception as e:
            logger.error(f"AI test_prompt error: {e}")
            return {'success': False, 'error': str(e)}

    def _call_openai_raw(self, api_key, model, system_prompt, user_message,
                         history=None, max_tokens=500, temperature=0.7):
        messages = [{'role': 'system', 'content': system_prompt}]
        if history:
            messages.extend(history)
        messages.append({'role': 'user', 'content': user_message})
        resp = requests.post(
            'https://api.openai.com/v1/chat/completions',
            headers={'Authorization': f'Bearer {api_key}', 'Content-Type': 'application/json'},
            json={'model': model, 'messages': messages, 'max_tokens': max_tokens, 'temperature': temperature},
            timeout=30
        )
        if resp.status_code != 200:
            try:
                err_data = resp.json().get('error', resp.text)
                error = err_data.get('message', str(err_data)) if isinstance(err_data, dict) else str(err_data)
            except Exception:
                error = resp.text
            return {'success': False, 'error': f'OpenAI API error: {error}'}
        data = resp.json()
        reply = data['choices'][0]['message']['content'].strip()
        return {'success': True, 'reply': reply, 'provider': 'openai', 'model': model}

    def _call_anthropic_raw(self, api_key, model, system_prompt, user_message,
                            history=None, max_tokens=500, temperature=0.7):
        messages = []
        if history:
            messages.extend(history)
        messages.append({'role': 'user', 'content': user_message})
        resp = requests.post(
            'https://api.anthropic.com/v1/messages',
            headers={'x-api-key': api_key, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json'},
            json={'model': model, 'system': system_prompt, 'messages': messages,
                  'max_tokens': max_tokens, 'temperature': temperature},
            timeout=30
        )
        if resp.status_code != 200:
            try:
                err_data = resp.json().get('error', resp.text)
                error = err_data.get('message', str(err_data)) if isinstance(err_data, dict) else str(err_data)
            except Exception:
                error = resp.text
            return {'success': False, 'error': f'Anthropic API error: {error}'}
        data = resp.json()
        reply = data['content'][0]['text'].strip()
        return {'success': True, 'reply': reply, 'provider': 'anthropic', 'model': model}

    def _call_grok_raw(self, api_key, model, system_prompt, user_message,
                        history=None, max_tokens=500, temperature=0.7):
        messages = [{'role': 'system', 'content': system_prompt}]
        if history:
            messages.extend(history)
        messages.append({'role': 'user', 'content': user_message})
        resp = requests.post(
            'https://api.x.ai/v1/chat/completions',
            headers={'Authorization': f'Bearer {api_key}', 'Content-Type': 'application/json'},
            json={'model': model, 'messages': messages, 'max_tokens': max_tokens, 'temperature': temperature},
            timeout=30
        )
        if resp.status_code != 200:
            try:
                err_data = resp.json().get('error', resp.text)
                error = err_data.get('message', str(err_data)) if isinstance(err_data, dict) else str(err_data)
            except Exception:
                error = resp.text
            return {'success': False, 'error': f'Grok API error: {error}'}
        data = resp.json()
        reply = data['choices'][0]['message']['content'].strip()
        return {'success': True, 'reply': reply, 'provider': 'grok', 'model': model}

    # ==================== AI UTILITIES ====================

    def _call_ai_simple(self, system_prompt, user_message, max_tokens=10, temperature=0):
        """One-shot AI call using the configured provider. Returns reply string or None."""
        config = self.get_config()
        if not config or not config.api_key:
            return None
        try:
            if config.provider == 'anthropic':
                result = self._call_anthropic_raw(
                    config.api_key, config.model or 'claude-sonnet-4-5-20250929',
                    system_prompt, user_message, [], max_tokens, temperature)
            elif config.provider == 'grok':
                result = self._call_grok_raw(
                    config.api_key, config.model or 'grok-4-fast-non-reasoning',
                    system_prompt, user_message, [], max_tokens, temperature)
            else:
                result = self._call_openai_raw(
                    config.api_key, config.model or 'gpt-4o-mini',
                    system_prompt, user_message, [], max_tokens, temperature)
            if result.get('success'):
                return result['reply'].strip()
            return None
        except Exception as e:
            logger.error(f"_call_ai_simple error: {e}")
            return None

    def extract_name_with_ai(self, account_id, chat_id, latest_text):
        """Extract user's first name from conversation history using AI.
        Returns name string or None."""
        history = self.get_conversation_history(account_id, chat_id, limit=10)
        history_text = ""
        for msg in history:
            role = "User" if msg['role'] == 'user' else "Bot"
            history_text += f"{role}: {msg['content']}\n"
        history_text += f"User: {latest_text}\n"

        system_prompt = (
            "Du bekommst einen Chat-Verlauf. Extrahiere den Vornamen des Users "
            "(nicht den Bot-Namen). Antworte NUR mit dem Vornamen (ein Wort). "
            "Wenn kein Name erkennbar ist, antworte mit NONE."
        )
        result = self._call_ai_simple(system_prompt, history_text, max_tokens=10, temperature=0)
        if not result or result.upper() == 'NONE' or len(result) > 25:
            return None
        # Clean: take first word, strip punctuation
        name = result.split()[0].strip('.,!?:;')
        if len(name) < 2:
            return None
        return name

    def detect_photo_skepticism(self, text):
        """AI classifier: returns True if text expresses photo/identity doubt."""
        system_prompt = (
            "Analysiere ob die Nachricht Zweifel an der Identität oder den Fotos "
            "der Gesprächspartnerin ausdrückt (z.B. 'bist du echt?', 'fake', "
            "'schick beweis', 'glaub ich nicht', 'catfish'). "
            "Antworte NUR mit YES oder NO."
        )
        result = self._call_ai_simple(system_prompt, text, max_tokens=3, temperature=0)
        if not result:
            return False
        return result.strip().upper().startswith('YES')
