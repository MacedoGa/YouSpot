#!/usr/bin/env python3
"""Smoke test de UI: 2 navegadores, um cria a jam, o outro entra pelo código,
adiciona uma faixa por link do YouTube e a fila aparece igual nos dois.

Uso: python3 test/e2e/ui_smoke.py   (sai com 0 se ok)
"""
import json
import os
import subprocess
import sys
import threading

from playwright.sync_api import sync_playwright, expect

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SERVE = os.path.join(ROOT, "test", "e2e", "serve.js")
YT_LINK = "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
TIMEOUT = 10_000


def start_server():
    proc = subprocess.Popen(
        ["node", SERVE, "--serve"], cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True
    )
    line = proc.stdout.readline()
    if not line:
        err = proc.stderr.read()
        raise RuntimeError(f"servidor não subiu:\n{err}")
    info = json.loads(line)
    # drena stderr/stdout para não travar o processo
    for stream in (proc.stdout, proc.stderr):
        threading.Thread(target=lambda s=stream: [None for _ in s], daemon=True).start()
    return proc, info


def new_page(browser, base, errors, label):
    ctx = browser.new_context(base_url=base)
    # Sem rede externa: bloqueia YouTube (iframe API/player) e qualquer host que não seja o local.
    ctx.route("**/*", lambda route: route.continue_() if route.request.url.startswith(base) else route.abort())
    page = ctx.new_page()
    page.on("pageerror", lambda e: errors.append(f"[{label}] pageerror: {e}"))
    page.set_default_timeout(TIMEOUT)
    return ctx, page


def queue_ids(page):
    return page.eval_on_selector_all("#queueList li[data-track-id]", "els => els.map(e => e.dataset.trackId)")


def main():
    proc, info = start_server()
    base = info["base"]
    errors = []
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            ctx_a, a = new_page(browser, base, errors, "A")
            ctx_b, b = new_page(browser, base, errors, "B")

            # A cria a jam
            a.goto("/")
            a.fill("#nameInput", "Ana")
            a.click("#createBtn")
            expect(a.locator("#room")).to_be_visible()
            expect(a.locator("#roomCode")).not_to_have_text("----")
            code = a.locator("#roomCode").inner_text().strip()
            assert len(code) >= 4, f"código inválido: {code!r}"

            # B entra pelo código
            b.goto("/")
            b.fill("#nameInput", "Bia")
            b.fill("#codeInput", code)
            b.click("#joinBtn")
            expect(b.locator("#room")).to_be_visible()
            expect(b.locator("#roomCode")).to_have_text(code)

            # B adiciona faixa por link do YouTube
            b.click("#tabSearch")
            b.click("#sourceYoutube")
            b.fill("#searchInput", YT_LINK)
            b.click("#searchBtn")
            b.locator('#searchList [data-add="0"]').click()

            # fila aparece igual nos dois
            for page in (a, b):
                page.click("#tabQueue")
                expect(page.locator("#queueList li[data-track-id]")).to_have_count(1)
                expect(page.locator("#queueList li[data-track-id]").first).to_contain_text("Never Gonna Give You Up")
            ids_a, ids_b = queue_ids(a), queue_ids(b)
            assert ids_a == ids_b and len(ids_a) == 1, f"filas diferentes: {ids_a} vs {ids_b}"
            # a faixa atual é a mesma nos dois
            expect(a.locator("#title")).to_contain_text("Never Gonna Give You Up")
            expect(b.locator("#title")).to_contain_text("Never Gonna Give You Up")

            # "Pessoas" mostra os dois
            for page in (a, b):
                expect(page.locator("#peopleCount")).to_have_text("(2)")

            ctx_a.close()
            ctx_b.close()
            browser.close()
        if errors:
            print("Erros de JavaScript na página:\n" + "\n".join(errors), file=sys.stderr)
            return 1
        print("ui_smoke: OK")
        return 0
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:  # noqa: BLE001
        print(f"ui_smoke: FALHOU: {exc}", file=sys.stderr)
        sys.exit(1)
