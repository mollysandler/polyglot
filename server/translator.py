"""
Thin async wrapper around Google Translate (deep_translator).

GoogleTranslator is not thread-safe, so we create a new instance per call
and run it in an executor for async compatibility.
"""

from __future__ import annotations

import asyncio
from functools import partial


async def translate_text(
    text: str,
    source_lang: str,
    target_lang: str,
    loop: asyncio.AbstractEventLoop | None = None,
) -> str:
    """Translate *text* from *source_lang* to *target_lang* using Google Translate.

    Runs in the default executor to avoid blocking the event loop.
    Returns the translated string, or the original text on failure.
    """
    if not text or not text.strip():
        return text

    if source_lang == target_lang:
        return text

    loop = loop or asyncio.get_running_loop()
    return await loop.run_in_executor(None, partial(_translate_sync, text, source_lang, target_lang))


def _translate_sync(text: str, source_lang: str, target_lang: str) -> str:
    from deep_translator import GoogleTranslator

    try:
        result = GoogleTranslator(source=source_lang, target=target_lang).translate(text)
        return result or text
    except Exception as e:
        print(f"[translator] Translation failed: {e}")
        return text
