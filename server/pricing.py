"""Model pricing table and cost helpers for Tripwire.

NOTE: All prices below are CONFIGURABLE ESTIMATES (USD per million tokens),
not authoritative provider pricing. Edit PRICES to match your contract.
"""
from __future__ import annotations

# model -> (usd_per_mtok_in, usd_per_mtok_out)   -- configurable estimates
PRICES: dict[str, tuple[float, float]] = {
    "claude-opus-5-5": (5.0, 25.0),
    "claude-sonnet-5-5": (3.0, 15.0),
    "claude-haiku-5-5": (1.0, 5.0),
    "mock-large": (15.0, 75.0),
    "mock-small": (1.0, 5.0),
}

# Used for any model we cannot match (configurable estimate).
DEFAULT_PRICE: tuple[float, float] = (3.0, 15.0)

# Family fallbacks for dated / unlisted model ids, e.g. "claude-sonnet-4-5-20250929".
_FAMILY_PRICES: dict[str, tuple[float, float]] = {
    "opus": PRICES["claude-opus-5-5"],
    "sonnet": PRICES["claude-sonnet-5-5"],
    "haiku": PRICES["claude-haiku-5-5"],
}


def price_for(model: str) -> tuple[float, float]:
    """Return (usd_per_mtok_in, usd_per_mtok_out) for a model id."""
    if model in PRICES:
        return PRICES[model]
    m = (model or "").lower()
    # Longest listed key that prefixes the id (handles date suffixes).
    best = ""
    for key in PRICES:
        if m.startswith(key) and len(key) > len(best):
            best = key
    if best:
        return PRICES[best]
    for family, price in _FAMILY_PRICES.items():
        if family in m:
            return price
    return DEFAULT_PRICE


def cost(model: str, in_tok: int, out_tok: int) -> float:
    """USD cost of one request given token counts."""
    p_in, p_out = price_for(model)
    return (max(0, in_tok) * p_in + max(0, out_tok) * p_out) / 1_000_000


def cheaper_model(model: str) -> str:
    """Next cheaper model: opus -> sonnet -> haiku; mock-large -> mock-small.

    Anything else (including already-cheapest models) returns the same model.
    """
    if not model:
        return model
    if model.startswith("mock-large"):
        return "mock-small" + model[len("mock-large"):]
    if "opus" in model:
        return model.replace("opus", "sonnet", 1)
    if "sonnet" in model:
        return model.replace("sonnet", "haiku", 1)
    return model
