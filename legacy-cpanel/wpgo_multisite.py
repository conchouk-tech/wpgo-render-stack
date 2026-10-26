from __future__ import annotations

import re
from typing import Any


class RemoteWordPressError(RuntimeError):
    pass


def _slug(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", str(value or "").lower()).strip("-")


def _normalize_url(value: str) -> str:
    return str(value or "").strip().rstrip("/").lower()


def _controller_result(data: Any) -> Any:
    return data.get("result") if isinstance(data, dict) and "result" in data else data


class ControllerRemoteClient:
    """Credential-blind bridge to a site stored in WPGo's encrypted controller."""

    def __init__(self, local_client: Any, row: dict[str, Any]):
        self.local = local_client
        self.row = row
        self.site_id = str(row["id"])

    async def _read_ability(self, ability: str, input_value: Any = None) -> Any:
        data = await self.local.run_readonly_ability(
            "wpgo/controller-read-ability",
            {"site_id": self.site_id, "ability": ability, "input": input_value or {}},
        )
        return _controller_result(data)

    async def _command_read(self, command: str, args: dict[str, Any] | None = None) -> Any:
        data = await self.local.run_readonly_ability(
            "wpgo/controller-command-read",
            {"site_id": self.site_id, "command": command, "args": args or {}},
        )
        return _controller_result(data)

    async def run_readonly_ability(self, name: str, input_value: Any) -> Any:
        return await self._read_ability(name, input_value)

    async def request(self, route: str, *, method: str = "GET", query: dict[str, Any] | None = None, body: Any = None) -> Any:
        method = str(method or "GET").upper()
        query = query or {}
        if method == "GET" and route == "/wpgo/v1/site":
            return await self._read_ability("wpgo/get-site-info", {})
        if method == "GET" and route == "/wpgo/v1/plugins":
            return await self._command_read("plugin.list", {})
        if method == "GET" and route == "/wpgo/v1/themes":
            return await self._command_read("theme.list", {})
        if method == "GET" and route == "/wpgo/v1/woocommerce/status":
            return await self._read_ability("wpgo/get-woocommerce-status", {})
        if method == "GET" and route == "/wpgo/v1/system/cron":
            return await self._command_read("cron.list", {})
        if method == "GET" and route == "/wpgo/v1/system/diagnostics":
            return await self._read_ability("wpgo/site-snapshot", {})
        if method == "GET" and route.startswith("/wpgo/v1/approvals/"):
            approval_id = route.rsplit("/", 1)[-1]
            data = await self.local.run_readonly_ability(
                "wpgo/controller-remote-approval-status",
                {"site_id": self.site_id, "approval_id": approval_id},
            )
            return _controller_result(data)
        if method == "GET" and route.startswith("/wpgo/v1/builders/inspect/"):
            return await self._read_ability("wpgo/builder-inspect", {"post_id": int(route.rsplit("/", 1)[-1])})
        if method == "GET" and (route.startswith("/wp/v2/") or route.startswith("/wp-abilities/") or route.startswith("/wc/v3/")):
            wrapped = await self._read_ability("wpgo/rest-read", {"route": route, "query": query})
            return wrapped.get("data") if isinstance(wrapped, dict) and "data" in wrapped else wrapped
        if method == "POST" and route == "/wpgo/v1/abilities/run" and isinstance(body, dict):
            controller_body: dict[str, Any] = {
                "ability": "wpgo/controller-run-ability",
                "input": {
                    "site_id": self.site_id,
                    "ability": str(body.get("ability") or ""),
                    "input": body.get("input") if isinstance(body.get("input"), dict) else {"value": body.get("input")},
                },
            }
            if body.get("approval_id"):
                controller_body["approval_id"] = body["approval_id"]
            return await self.local.request("/wpgo/v1/abilities/run", method="POST", body=controller_body)
        raise RemoteWordPressError(
            f"Legacy remote route {method} {route} is not mapped. Use run_wordpress_ability for guarded remote actions or RC3."
        )


class MultiSiteBridge:
    def __init__(self, local_client: Any, local_site: Any):
        self.local = local_client
        self.local_site = local_site

    async def controller_sites(self) -> list[dict[str, Any]]:
        try:
            data = await self.local.run_readonly_ability("wpgo/controller-list-sites", {})
        except Exception:
            return []
        rows = data.get("sites", []) if isinstance(data, dict) else []
        return [r for r in rows if isinstance(r, dict) and r.get("id") and r.get("url")]

    def _matches(self, requested: str, row: dict[str, Any]) -> bool:
        low = str(requested or "").strip().lower().rstrip("/")
        if not low:
            return False
        url = str(row.get("url") or "").lower().rstrip("/")
        name = str(row.get("name") or row.get("label") or "")
        host = url.split("://", 1)[-1].split("/", 1)[0] if url else ""
        aliases = {str(row.get("id") or "").lower(), url, host, host.split(".", 1)[0] if host else "", name.lower(), _slug(name)}
        return low in {a for a in aliases if a}

    async def list_sites(self) -> list[dict[str, Any]]:
        sites = [{"id": self.local_site.id, "name": self.local_site.name, "url": self.local_site.url, "connection": "direct"}]
        seen = {_normalize_url(self.local_site.url)}
        for row in await self.controller_sites():
            url = str(row.get("url") or "").rstrip("/")
            if not url or _normalize_url(url) in seen:
                continue
            seen.add(_normalize_url(url))
            sites.append({
                "id": str(row["id"]), "name": str(row.get("label") or row.get("url")), "url": url,
                "connection": "controller", "wpgo_version": row.get("wpgo_version"), "wordpress_version": row.get("wordpress_version"),
            })
        return sites

    async def client_for(self, requested: str | None) -> Any:
        local = {"id": self.local_site.id, "name": self.local_site.name, "url": self.local_site.url}
        if not requested or self._matches(requested, local):
            return self.local
        for row in await self.controller_sites():
            if self._matches(requested, row):
                return ControllerRemoteClient(self.local, row)
        known = ", ".join(s["id"] for s in await self.list_sites())
        raise ValueError(f"Unknown site '{requested}'. Available sites: {known}.")

    async def fleet_overview(self) -> dict[str, Any]:
        sites: list[dict[str, Any]] = []
        try:
            sites.append({"id": self.local_site.id, "ok": True, "info": await self.local.request("/wpgo/v1/site"), "connection": "direct"})
        except Exception as exc:
            sites.append({"id": self.local_site.id, "ok": False, "error": str(exc), "connection": "direct"})
        try:
            remote = await self.local.run_readonly_ability("wpgo/controller-fleet-snapshot", {})
            results = remote.get("results", {}) if isinstance(remote, dict) else {}
            registry = {str(r.get("id")): r for r in await self.controller_sites()}
            for site_id, result in (results.items() if isinstance(results, dict) else []):
                if not isinstance(result, dict):
                    continue
                meta = registry.get(str(site_id), {})
                row = {"id": str(site_id), "name": str(meta.get("label") or meta.get("url") or site_id), "url": str(meta.get("url") or "").rstrip("/"),
                       "ok": bool(result.get("ok")), "info": result.get("snapshot"), "connection": "controller"}
                if result.get("error"):
                    row["error"] = result.get("error")
                sites.append(row)
        except Exception as exc:
            sites.append({"id": "controller", "ok": False, "error": str(exc), "connection": "controller"})
        return {"sites": sites}

    async def fleet_updates(self) -> dict[str, Any]:
        sites: list[dict[str, Any]] = []
        for row in await self.list_sites():
            try:
                if row.get("connection") == "direct":
                    updates = await self.local.request("/wpgo/v1/system/updates")
                else:
                    health = await self.local.run_readonly_ability("wpgo/controller-site-health", {"site_id": row["id"]})
                    snapshot = health.get("snapshot", {}) if isinstance(health, dict) else {}
                    updates = {"counts": snapshot.get("update_counts", {})}
                sites.append({"id": row["id"], "ok": True, "updates": updates})
            except Exception as exc:
                sites.append({"id": row["id"], "ok": False, "error": str(exc)})
        return {"sites": sites}
