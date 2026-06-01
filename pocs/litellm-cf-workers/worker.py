from importlib import import_module
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from workers import WorkerEntrypoint, Response
import asgi


class Constants:
    """POC constants with explicit meanings and limited scope."""

    ADMIN_KEY = "ADMIN_KEY"
    OPENAI_API_KEY = "OPENAI_API_KEY"
    LITELLM_API_KEY = "LITELLM_API_KEY"
    LITELLM_BASE_URL = "LITELLM_BASE_URL"
    LITELLM_MODEL = "LITELLM_MODEL"
    BEARER_PREFIX = "Bearer "
    DEFAULT_MODEL = "openai/gpt-4o-mini"
    ERROR_TYPE_AUTH = "authentication_error"
    ERROR_TYPE_BAD_REQUEST = "invalid_request_error"
    ERROR_TYPE_UPSTREAM = "litellm_error"
    ERROR_TYPE_IMPORT = "import_error"


class ChatMessage(BaseModel):
    role: str = Field(..., description="OpenAI-compatible message role.")
    content: Any = Field(..., description="Message content passed to LiteLLM without rewriting.")


class ChatCompletionRequest(BaseModel):
    model: str | None = Field(
        default=None,
        description="LiteLLM model name. Uses LITELLM_MODEL or the POC default when omitted.",
    )
    messages: list[ChatMessage] = Field(
        ...,
        min_length=1,
        description="OpenAI-compatible message list. At least one message is required.",
    )
    stream: bool = Field(
        default=False,
        description="POC intentionally rejects true to isolate non-streaming compatibility first.",
    )
    temperature: float | None = Field(default=None, description="Optional sampling temperature.")
    max_tokens: int | None = Field(default=None, ge=1, description="Optional output token limit.")
    extra_body: dict[str, Any] | None = Field(default=None, description="Optional provider-specific body.")


app = FastAPI(title="Open AI Gateway Python LiteLLM POC")


def build_error_response(message: str, status_code: int, error_type: str = "poc_error") -> JSONResponse:
    return JSONResponse(
        status_code=status_code,
        content={"error": {"message": message, "type": error_type}},
    )


def get_env_value(env: object, name: str, default: str | None = None) -> str | None:
    if env is None:
        return default
    value = getattr(env, name, None)
    if value is None and isinstance(env, dict):
        value = env.get(name)
    if value is None:
        return default
    return str(value)


def get_bearer_token(authorization: str | None) -> str | None:
    if not authorization or not authorization.startswith(Constants.BEARER_PREFIX):
        return None
    token = authorization[len(Constants.BEARER_PREFIX) :].strip()
    return token or None


def ensure_authorized(request: Request) -> None:
    env = request.scope.get("env")
    admin_key = get_env_value(env, Constants.ADMIN_KEY)
    if not admin_key:
        return
    token = get_bearer_token(request.headers.get("authorization"))
    if token != admin_key:
        raise HTTPException(status_code=401, detail="Missing or invalid authorization token")


def to_jsonable_response(value: object) -> object:
    if hasattr(value, "model_dump"):
        return value.model_dump(mode="json")
    if hasattr(value, "dict"):
        return value.dict()
    if isinstance(value, dict):
        return value
    return value


async def import_litellm() -> object:
    return import_module("litellm")


@app.exception_handler(HTTPException)
async def http_exception_handler(_request: Request, exc: HTTPException) -> JSONResponse:
    error_type = Constants.ERROR_TYPE_AUTH if exc.status_code == 401 else Constants.ERROR_TYPE_BAD_REQUEST
    return build_error_response(str(exc.detail), exc.status_code, error_type)


@app.get("/healthz")
async def healthz() -> dict[str, Any]:
    return {
        "ok": True,
        "runtime": "cloudflare-python-workers",
        "framework": "fastapi",
        "poc": "litellm",
    }


@app.get("/litellm/import")
async def litellm_import_check() -> JSONResponse:
    try:
        litellm = await import_litellm()
        return JSONResponse(
            {
                "ok": True,
                "package": "litellm",
                "version": getattr(litellm, "__version__", "unknown"),
                "module": getattr(litellm, "__file__", "unknown"),
            }
        )
    except Exception as error:
        return JSONResponse(
            status_code=500,
            content={
                "ok": False,
                "package": "litellm",
                "error_type": type(error).__name__,
                "error": str(error),
            },
        )


@app.post("/v1/chat/completions")
async def chat_completions(payload: ChatCompletionRequest, request: Request) -> JSONResponse:
    ensure_authorized(request)
    if payload.stream:
        return build_error_response(
            "Streaming is intentionally disabled in this POC. Test non-streaming first.",
            400,
            Constants.ERROR_TYPE_BAD_REQUEST,
        )

    env = request.scope.get("env")
    model = payload.model or get_env_value(env, Constants.LITELLM_MODEL, Constants.DEFAULT_MODEL)
    api_key = get_env_value(env, Constants.OPENAI_API_KEY) or get_env_value(env, Constants.LITELLM_API_KEY)
    base_url = get_env_value(env, Constants.LITELLM_BASE_URL)

    try:
        litellm = await import_litellm()
    except Exception as error:
        return build_error_response(
            f"LiteLLM import failed: {type(error).__name__}: {error}",
            500,
            Constants.ERROR_TYPE_IMPORT,
        )

    request_kwargs: dict[str, Any] = {
        "model": model,
        "messages": [message.model_dump(mode="json") for message in payload.messages],
    }
    if api_key:
        request_kwargs["api_key"] = api_key
    if base_url:
        request_kwargs["api_base"] = base_url
    if payload.temperature is not None:
        request_kwargs["temperature"] = payload.temperature
    if payload.max_tokens is not None:
        request_kwargs["max_tokens"] = payload.max_tokens
    if payload.extra_body:
        request_kwargs["extra_body"] = payload.extra_body

    try:
        response = await litellm.acompletion(**request_kwargs)
        return JSONResponse(to_jsonable_response(response))
    except Exception as error:
        return build_error_response(
            f"{type(error).__name__}: {error}",
            502,
            Constants.ERROR_TYPE_UPSTREAM,
        )


class Default(WorkerEntrypoint):
    async def fetch(self, request) -> Response:
        return await asgi.fetch(app, request, self.env)
