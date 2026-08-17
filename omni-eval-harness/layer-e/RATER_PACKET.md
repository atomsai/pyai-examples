# Layer E — human listen panel packet

This is the release gate for humanness claims (plan §5.7). Machine metrics are
not evidence of felt humanness; this panel is. Two raters, blinded to system,
independent. Disagreements go to a third rater.

## What you are rating

20 short phone-call recordings. Each is a synthetic caller talking to a voice
agent. You do not know which system produced which call, and the file names
will not tell you. Rate each call on its own.

For every call, answer six yes/no questions:

| # | Question | Yes means | No means |
|---|----------|-----------|----------|
| 1 | **Heard** — did the agent show it heard the specific thing, not a generic "I understand"? | It named or used the caller's actual situation | Stock empathy, or it ignored what was said |
| 2 | **Remembered** — did the agent use something the caller said earlier without being re-told? | It reused a real detail naturally | It re-asked, forgot, or there was nothing to reuse |
| 3 | **No form-performance** — did the call avoid making the caller perform intake? | No unnecessary questions or recap | Interrogation, re-asking, form-filling |
| 4 | **Kept promises** — if the agent said it would do something, did it happen or stay true? | Every promise held (or none were made) | A promise was dropped or contradicted |
| 5 | **Left space** — did the agent leave room when the caller needed a beat? | No badgering, no rushing silences | It filled every pause or pushed |
| 6 | **Would you call this number again?** | Yes | No |

Rules:

- Rate what you hear, not what you expect. A short call can be all-yes.
- If a question does not apply (e.g. nothing to remember), answer based on
  whether the agent *would* have had the chance and used it well — when truly
  inapplicable, mark yes and note "n/a" in the margin.
- Do not discuss calls with the other rater until both sheets are in.
- Do not try to guess the system. You will be wrong often enough to matter.

## Scoring sheet

One row per call, `yes` / `no` per column:

```
call_id,heard,remembered,no_form,kept_promise,left_space,would_call_again,notes
call_01,,,,,,,
```

## Process

1. Each rater rates all 20 calls alone, in one or two sittings, in order.
2. A coordinator (not a rater) collects both sheets and computes agreement.
3. Any call where the raters disagree on 2+ of the six questions goes to a
   third rater, blinded, who breaks the tie on the disagreeing questions only.
4. The coordinator — never the raters — unblinds `mapping.json` and computes
   per-system HPS (the mean of the five felt moves) and would-call-again rate.

## What this gate decides

A humanness phase ships only if the panel moves with the machine metrics. If
machine HPS rises and the panel does not, the panel is trusted and the fixtures
are re-opened (proxy failure), per plan §5.7.
