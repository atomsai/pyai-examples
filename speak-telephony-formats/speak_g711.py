#!/usr/bin/env python3
"""One streaming test-project greeting; see README for setup and timeout limits."""
import json
import math
import os
from contextlib import closing
from pathlib import Path
from pyai import PyAI


def main():
    project_id = os.environ["PYAI_PROJECT_ID"]
    with PyAI(api_key=os.environ["PYAI_API_KEY"],
              base_url=os.environ.get("PYAI_BASE_URL", "https://api.pyai.com"),
              max_retries=0, timeout=30) as pyai:
        me = pyai.me()
        print(json.dumps({k: me.get(k) for k in (
            "org_id", "project_id", "env", "limits", "credit", "key_budget_cents")}))
        if me.get("project_id") != project_id or me.get("env") != "test":
            raise ValueError("Expected test project mismatch; no synthesis requested")
        if "speak:synthesize" not in me.get("scopes", []):
            raise ValueError("Missing speak:synthesize")
        limits = me.get("limits")
        if not isinstance(limits, dict):
            raise ValueError("Missing test-project limits")
        cap = limits.get("daily_unit_cap")
        if cap is not None and (isinstance(cap, bool) or not isinstance(cap, (int, float))
                                or not math.isfinite(cap) or cap <= 0):
            raise ValueError("Invalid or zero test daily cap")
        if cap is None:
            print("No daily cap enforced; this run is still bounded to one 49-character request.")
        path = Path("out.ulaw")
        # Open exclusively before generation; never overwrite an existing result.
        with path.open("xb") as output:
            try:
                with closing(pyai.audio.speech_stream(
                    input="Your appointment is confirmed for Tuesday at ten.",
                    voice=os.environ.get("PYAI_VOICE", "stock_emma_en_gb"),
                    response_format="g711_ulaw", sample_rate=8000,
                )) as chunks:
                    for chunk in chunks:
                        output.write(chunk)
            except BaseException:
                path.unlink(missing_ok=True)
                raise
    print("Wrote out.ulaw: raw 8 kHz mono μ-law. No call was placed.")


if __name__ == "__main__":
    main()
