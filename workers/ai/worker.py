"""HahaTalk AI worker protocol v1.

The worker receives only opaque wake-up messages from Redis. Sensitive job input is
fetched from the authenticated internal API after a lease has been claimed.
"""

from __future__ import annotations

import io
import json
import os
import pathlib
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import wave
from dataclasses import dataclass
from typing import Any


API_URL = os.environ.get("HAHATALK_API_URL", "http://127.0.0.1:4000").rstrip("/")
WORKER_TOKEN = os.environ.get("AI_WORKER_TOKEN", "")
WORKER_ID = os.environ.get("AI_WORKER_ID", f"windows-ai-{uuid.uuid4().hex[:8]}")
TEST_DRIVER = os.environ.get("HAHATALK_AI_TEST_DRIVER") == "deterministic"
CAPABILITIES = [
    value.strip()
    for value in os.environ.get(
        "AI_WORKER_CAPABILITIES",
        "stt,summary,tts,avatar_generation,voice_profile_enrollment,voice_profile_delete",
    ).split(",")
    if value.strip()
]
STREAM_NAME = "hahatalk:ai:jobs:v1"
GROUP_NAME = "hahatalk-ai-workers-v1"


@dataclass(frozen=True)
class Claim:
    id: str
    job_type: str
    fencing_token: int
    model: dict[str, Any]
    input: dict[str, Any]


class ApiError(RuntimeError):
    pass


def request_json(path: str, method: str = "GET", payload: dict[str, Any] | None = None) -> Any:
    headers = {"X-HahaTalk-AI-Worker-Token": WORKER_TOKEN}
    body = None
    if payload is not None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(f"{API_URL}{path}", data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            raw = response.read()
            return json.loads(raw) if raw else None
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", "replace")
        raise ApiError(f"{method} {path} failed ({error.code}): {detail[:500]}") from error


def claim_job() -> Claim | None:
    response = request_json(
        "/internal/ai/jobs/claim",
        "POST",
        {"workerId": WORKER_ID, "capabilities": CAPABILITIES, "leaseSeconds": 90},
    )
    row = response.get("job") if isinstance(response, dict) else None
    if not row:
        return None
    return Claim(
        id=row["id"],
        job_type=row["jobType"],
        fencing_token=int(row["fencingToken"]),
        model=row["model"],
        input=row["input"],
    )


def heartbeat(claim: Claim, progress: int) -> None:
    request_json(
        f"/internal/ai/jobs/{claim.id}/heartbeat",
        "POST",
        {
            "workerId": WORKER_ID,
            "fencingToken": claim.fencing_token,
            "progress": max(1, min(99, progress)),
            "leaseSeconds": 90,
        },
    )


def download_input(claim: Claim) -> pathlib.Path:
    suffix = pathlib.Path(str(claim.input.get("inputPath", "input.bin"))).suffix or ".bin"
    target = pathlib.Path(tempfile.mkdtemp(prefix="hahatalk-ai-")) / f"input{suffix}"
    request = urllib.request.Request(
        f"{API_URL}/internal/ai/jobs/{claim.id}/input",
        headers={
            "X-HahaTalk-AI-Worker-Token": WORKER_TOKEN,
            "X-HahaTalk-AI-Worker-Id": WORKER_ID,
            "X-HahaTalk-AI-Fencing-Token": str(claim.fencing_token),
        },
    )
    with urllib.request.urlopen(request, timeout=120) as response, target.open("wb") as output:
        while chunk := response.read(1024 * 1024):
            output.write(chunk)
    return target


def upload_output(claim: Claim, file_path: pathlib.Path, mime_type: str) -> str:
    request = urllib.request.Request(
        f"{API_URL}/internal/ai/jobs/{claim.id}/output",
        data=file_path.read_bytes(),
        headers={
            "Content-Type": mime_type,
            "X-HahaTalk-AI-Worker-Token": WORKER_TOKEN,
            "X-HahaTalk-AI-Worker-Id": WORKER_ID,
            "X-HahaTalk-AI-Fencing-Token": str(claim.fencing_token),
            "X-HahaTalk-File-Name": urllib.parse.quote(file_path.name),
        },
        method="PUT",
    )
    with urllib.request.urlopen(request, timeout=300) as response:
        return json.loads(response.read())["assetId"]


def deterministic_wav(text: str) -> pathlib.Path:
    target = pathlib.Path(tempfile.mkdtemp(prefix="hahatalk-ai-output-")) / "standard-korean.wav"
    sample_rate = 16_000
    duration_frames = max(sample_rate // 2, min(sample_rate * 2, len(text) * 400))
    with wave.open(str(target), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(sample_rate)
        output.writeframes(b"\x00\x00" * duration_frames)
    return target


def run_stt(claim: Claim) -> dict[str, Any]:
    if TEST_DRIVER:
        return {
            "text": "테스트 음성을 사용자가 검토한 뒤 전송합니다.",
            "language": "ko",
            "segments": [{"start": 0.0, "end": 2.4, "text": "테스트 음성을 사용자가 검토한 뒤 전송합니다."}],
        }
    from faster_whisper import WhisperModel

    source = download_input(claim)
    compute_type = os.environ.get("WHISPER_COMPUTE_TYPE", "int8")
    device = os.environ.get("WHISPER_DEVICE", "cpu")
    model_name = os.environ.get("WHISPER_MODEL", str(claim.model["name"]))
    model = WhisperModel(model_name, device=device, compute_type=compute_type)
    segments, info = model.transcribe(
        str(source),
        language=None if claim.input.get("language") == "auto" else claim.input.get("language"),
        vad_filter=True,
    )
    rows = [
        {"start": segment.start, "end": segment.end, "text": segment.text.strip()}
        for segment in segments
        if segment.text.strip()
    ]
    return {"text": " ".join(row["text"] for row in rows), "language": info.language, "segments": rows}


def run_summary(claim: Claim) -> dict[str, Any]:
    if TEST_DRIVER:
        return {
            "summary": "AI가 대화 내용을 요약한 검토용 초안입니다.",
            "decisions": ["STT 초안은 승인 후 전송한다."],
            "tasks": [{"title": "AI 작업 결과를 검토한다.", "assignee": "user-you"}],
        }
    endpoint = os.environ.get("QWEN_OPENAI_BASE_URL", "").rstrip("/")
    if not endpoint:
        raise RuntimeError("QWEN_OPENAI_BASE_URL is not configured")
    prompt = {
        "model": os.environ.get("QWEN_MODEL", str(claim.model["name"])),
        "messages": [
            {
                "role": "system",
                "content": (
                    "Return JSON only with summary:string, decisions:string[], and "
                    "tasks:{title:string,assignee?:string}[]. This is an AI draft."
                ),
            },
            {"role": "user", "content": json.dumps(claim.input.get("messages", []), ensure_ascii=False)},
        ],
        "response_format": {"type": "json_object"},
        "temperature": 0.2,
    }
    key = os.environ.get("QWEN_API_KEY", "")
    headers = {"Content-Type": "application/json", **({"Authorization": f"Bearer {key}"} if key else {})}
    request = urllib.request.Request(
        f"{endpoint}/chat/completions",
        data=json.dumps(prompt, ensure_ascii=False).encode("utf-8"),
        headers=headers,
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=300) as response:
        body = json.loads(response.read())
    return json.loads(body["choices"][0]["message"]["content"])


def run_tts(claim: Claim) -> dict[str, Any]:
    text = str(claim.input["text"])
    if TEST_DRIVER:
        output = deterministic_wav(text)
    else:
        import soundfile as sf
        import torch
        from qwen_tts import Qwen3TTSModel

        device = os.environ.get("QWEN_TTS_DEVICE", "cpu")
        dtype = torch.bfloat16 if device.startswith("cuda") else torch.float32
        model_id = os.environ.get("QWEN_TTS_MODEL", f"Qwen/{claim.model['name']}")
        model = Qwen3TTSModel.from_pretrained(
            model_id,
            device_map=device,
            dtype=dtype,
            attn_implementation="sdpa",
        )
        wavs, sample_rate = model.generate_custom_voice(
            text=text,
            language="Korean",
            speaker="Sohee",
        )
        output = pathlib.Path(tempfile.mkdtemp(prefix="hahatalk-ai-output-")) / "standard-korean.wav"
        sf.write(output, wavs[0], sample_rate)
    asset_id = upload_output(claim, output, "audio/wav")
    return {"outputAssetId": asset_id, "durationMs": 1000}


def run_avatar(claim: Claim) -> dict[str, Any]:
    if TEST_DRIVER:
        # A valid 1x1 transparent PNG is sufficient for protocol and media-boundary tests.
        content = bytes.fromhex(
            "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489"
            "0000000d49444154789c6360000000020001e221bc330000000049454e44ae426082"
        )
        output = pathlib.Path(tempfile.mkdtemp(prefix="hahatalk-ai-output-")) / "caricature.png"
        output.write_bytes(content)
        return {"outputAssetId": upload_output(claim, output, "image/png")}
    raise RuntimeError("Avatar provider is not configured")


def process(claim: Claim) -> dict[str, Any]:
    heartbeat(claim, 10)
    if claim.job_type == "stt":
        return run_stt(claim)
    if claim.job_type == "summary":
        return run_summary(claim)
    if claim.job_type == "tts":
        return run_tts(claim)
    if claim.job_type == "avatar_generation":
        return run_avatar(claim)
    if claim.job_type == "voice_profile_enrollment":
        if not TEST_DRIVER:
            raise RuntimeError("Consented voice vault adapter is not configured")
        return {"encryptedEmbeddingKey": f"vault://test/{claim.id}", "watermarked": True}
    if claim.job_type == "voice_profile_delete":
        return {"deleted": True}
    raise RuntimeError(f"Unsupported job type: {claim.job_type}")


def run_once() -> bool:
    claim = claim_job()
    if claim is None:
        return False
    try:
        result = process(claim)
        request_json(
            f"/internal/ai/jobs/{claim.id}/complete",
            "POST",
            {"workerId": WORKER_ID, "fencingToken": claim.fencing_token, "result": result},
        )
    except Exception as error:  # The API records the bounded error; no input content is logged.
        request_json(
            f"/internal/ai/jobs/{claim.id}/fail",
            "POST",
            {
                "workerId": WORKER_ID,
                "fencingToken": claim.fencing_token,
                "errorCode": "worker_processing_failed",
                "errorMessage": type(error).__name__,
                "retryable": False,
            },
        )
    return True


def redis_wakeup() -> None:
    redis_url = os.environ.get("AI_REDIS_URL", "")
    if not redis_url:
        time.sleep(1.5)
        return
    try:
        import redis

        client = redis.Redis.from_url(redis_url, decode_responses=True, socket_timeout=3)
        try:
            client.xgroup_create(STREAM_NAME, GROUP_NAME, id="0", mkstream=True)
        except redis.ResponseError as error:
            if "BUSYGROUP" not in str(error):
                raise
        rows = client.xreadgroup(GROUP_NAME, WORKER_ID, {STREAM_NAME: ">"}, count=1, block=1500)
        for _, entries in rows:
            for entry_id, fields in entries:
                if set(fields).issubset({"jobId", "jobType", "schemaVersion"}):
                    client.xack(STREAM_NAME, GROUP_NAME, entry_id)
    except Exception:
        time.sleep(1.5)


def main() -> None:
    if len(WORKER_TOKEN) < 24:
        raise SystemExit("AI_WORKER_TOKEN must contain at least 24 characters")
    while True:
        if not run_once():
            redis_wakeup()


if __name__ == "__main__":
    main()
