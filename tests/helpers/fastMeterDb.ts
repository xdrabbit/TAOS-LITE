// A Postgres that fits in a test.
//
// The five functions in supabase/migrations/20260831_fast_metering.sql and
// 20260831_fast_speech_metering.sql, re-expressed against an in-memory store.
//
// It exists for the half of /fast's metering that SQL alone cannot show: the
// ORDER a route does things in. Whether the allowance is taken before the
// engine is called, whether a refused mint reaches Azure, whether a stream
// that ends gives its reservation back — those are properties of the route,
// and driving the route needs something on the other end of `supabaseAdmin`.
//
// It is NOT the proof that the SQL is right. That is a separate, live
// exercise against the real database, written up in the PR — a JS
// re-expression of plpgsql can only ever agree with itself, and this repo has
// already paid once for a green round trip that proved nothing.

export interface FakeRow {
  id: string;
  user_id: string;
  created_at: number;
  source_lang: string;
  target_lang: string;
  tone: string;
  original_text: string;
  translation_text: string;
  engine: string | null;
}

export interface FakeSpeechSession {
  id: string;
  user_id: string;
  minted_at: number;
  expires_at: number;
  granted_seconds: number;
  reported_seconds: number | null;
  billed_seconds: number;
  settled_at: number | null;
  end_reason: string | null;
}

let seq = 0;

export class FastMeterDb {
  now = Date.parse("2026-08-31T12:00:00Z");
  rows: FakeRow[] = [];
  rate = new Map<string, number>();
  quickies = new Map<
    string,
    { pair: string; lastSeen: number; rowId: string | null; adoptedText: string | null }
  >();
  profiles = new Map<string, { subscription_status: string; tier: string | null }>();
  speech: FakeSpeechSession[] = [];
  /** Flip to make fast_begin answer like a connection that died. */
  failBegin = false;

  reset(): void {
    this.now = Date.parse("2026-08-31T12:00:00Z");
    this.rows = [];
    this.rate.clear();
    this.quickies.clear();
    this.profiles.clear();
    this.speech = [];
    this.failBegin = false;
  }

  /** Rows for a user in the current calendar month — what the allowance counts. */
  monthRows(userId: string): FakeRow[] {
    const since = Date.UTC(2026, 7, 1);
    return this.rows.filter((r) => r.user_id === userId && r.created_at >= since);
  }

  /** Streaming seconds billed to a user in the rolling hour, plus open holds. */
  speechSecondsHeld(userId: string): number {
    const since = this.now - 3_600_000;
    const billed = this.speech
      .filter((s) => s.user_id === userId && s.settled_at !== null && s.minted_at >= since)
      .reduce((a, s) => a + s.billed_seconds, 0);
    const held = this.speech
      .filter((s) => s.user_id === userId && s.settled_at === null)
      .reduce((a, s) => a + s.granted_seconds, 0);
    return billed + held;
  }

  private bump(userId: string, window: string, widthMs: number): number {
    const bucket = Math.floor(this.now / widthMs) * widthMs;
    const key = `${userId}|${window}|${bucket}`;
    const next = (this.rate.get(key) ?? 0) + 1;
    this.rate.set(key, next);
    return next;
  }

  fastBegin(a: Record<string, unknown>): Record<string, unknown> {
    const userId = a.p_user_id as string;
    const src = a.p_source_lang as string;
    const tgt = a.p_target_lang as string;
    const text = a.p_text as string;
    const pair = `${src}>${tgt}`;

    if (this.bump(userId, "minute", 60_000) > Math.max(a.p_minute_limit as number, 1)) {
      return { ok: false, reason: "rate_minute" };
    }
    if (this.bump(userId, "hour", 3_600_000) > Math.max(a.p_hour_limit as number, 1)) {
      return { ok: false, reason: "rate_hour" };
    }

    const open = this.quickies.get(userId);
    if (
      open &&
      open.pair === pair &&
      open.rowId !== null &&
      this.now - open.lastSeen <= Math.max(a.p_window_ms as number, 0)
    ) {
      if (open.adoptedText === null) {
        open.lastSeen = this.now;
        const row = this.rows.find((r) => r.id === open.rowId && r.user_id === userId);
        if (row) row.original_text = text;
        return { ok: true, billed: false, row_id: open.rowId };
      }
      if (open.adoptedText.startsWith(text.trim())) {
        open.lastSeen = this.now;
        return { ok: true, billed: false, row_id: open.rowId, repeat: true };
      }
      // Diverged from what was adopted: a different question now.
    }

    // The visit-long billed set, durably: a settled row for these exact words
    // between these exact two languages, either way round, inside the window.
    const repeatMs = Math.max((a.p_repeat_ms as number) ?? 0, 0);
    if (repeatMs > 0) {
      const hit = [...this.rows]
        .reverse()
        .find(
          (r) =>
            r.user_id === userId &&
            r.translation_text !== "" &&
            r.original_text.trim().startsWith(text.trim()) &&
            ((r.source_lang === src && r.target_lang === tgt) ||
              (Boolean(a.p_auto) && r.source_lang === tgt && r.target_lang === src)) &&
            r.created_at >= this.now - repeatMs
        );
      if (hit) {
        this.quickies.set(userId, {
          pair,
          lastSeen: this.now,
          rowId: hit.id,
          adoptedText: hit.original_text.trim()
        });
        return { ok: true, billed: false, row_id: hit.id, repeat: true };
      }
    }

    let cap = -1;
    if (!a.p_unlimited) {
      const profile = this.profiles.get(userId);
      const tier =
        profile?.subscription_status === "comp"
          ? "comp"
          : profile?.subscription_status === "active"
            ? profile.tier === "premium"
              ? "premium"
              : "basic"
            : "free";
      const caps = a.p_caps as Record<string, number>;
      cap = caps[tier] ?? caps.free ?? 25;
    }

    let used = 0;
    if (cap >= 0) {
      used = this.monthRows(userId).length;
      if (used >= cap) return { ok: false, reason: "quota", used, cap };
    }

    const id = `row-${(seq += 1)}`;
    this.rows.push({
      id,
      user_id: userId,
      created_at: this.now,
      source_lang: src,
      target_lang: tgt,
      tone: "literal",
      original_text: text,
      translation_text: "",
      engine: "fast"
    });
    this.quickies.set(userId, { pair, lastSeen: this.now, rowId: id, adoptedText: null });
    return { ok: true, billed: true, row_id: id, used: cap >= 0 ? used + 1 : null, cap };
  }

  fastRecord(a: Record<string, unknown>): null {
    const row = this.rows.find((r) => r.id === a.p_row_id && r.user_id === a.p_user_id);
    if (row) {
      row.source_lang = a.p_source_lang as string;
      row.target_lang = a.p_target_lang as string;
      row.original_text = a.p_text as string;
      row.translation_text = a.p_translation as string;
      row.engine = (a.p_engine as string) || "fast";
    }
    return null;
  }

  fastAbandon(a: Record<string, unknown>): null {
    const open = this.quickies.get(a.p_user_id as string);
    if (open && open.rowId === a.p_row_id) this.quickies.delete(a.p_user_id as string);
    this.rows = this.rows.filter(
      (r) => !(r.id === a.p_row_id && r.user_id === a.p_user_id && r.translation_text === "")
    );
    return null;
  }

  fastSpeechMint(a: Record<string, unknown>): Record<string, unknown> {
    const userId = a.p_user_id as string;
    const grant = Math.max(a.p_grant_seconds as number, 1);

    // The reap: an open session whose token has expired settles at its FULL
    // grant. Azure was reachable that whole time with a credential we issued.
    for (const s of this.speech) {
      if (s.user_id === userId && s.settled_at === null && s.expires_at < this.now) {
        s.settled_at = this.now;
        s.billed_seconds = s.granted_seconds;
        s.end_reason = "lost";
      }
    }

    const budget = a.p_budget_seconds as number;
    if (!a.p_unlimited && budget >= 0) {
      const used = this.speechSecondsHeld(userId);
      if (used + grant > budget) {
        return { ok: false, reason: "budget", used_seconds: used, budget };
      }
    }

    const id = `spk-${(seq += 1)}`;
    this.speech.push({
      id,
      user_id: userId,
      minted_at: this.now,
      expires_at: this.now + Math.max(a.p_ttl_ms as number, 0),
      granted_seconds: grant,
      reported_seconds: null,
      billed_seconds: 0,
      settled_at: null,
      end_reason: null
    });
    return {
      ok: true,
      session_id: id,
      granted_seconds: grant,
      used_seconds: this.speechSecondsHeld(userId),
      budget
    };
  }

  fastSpeechSettle(a: Record<string, unknown>): number | null {
    const s = this.speech.find((x) => x.id === a.p_id && x.user_id === a.p_user_id);
    if (!s || s.settled_at !== null) return null;
    const reported = Math.max((a.p_seconds as number) ?? 0, 0);
    s.settled_at = this.now;
    s.reported_seconds = reported;
    s.billed_seconds = Math.min(reported, Math.max(s.granted_seconds, 0));
    s.end_reason = (a.p_reason as string) || "user";
    return s.billed_seconds;
  }

  /** The `supabaseAdmin.rpc` a route sees. */
  rpc = async (
    name: string,
    args: Record<string, unknown>
  ): Promise<{ data: unknown; error: { message: string } | null }> => {
    switch (name) {
      case "fast_begin":
        if (this.failBegin) return { data: null, error: { message: "connection reset" } };
        return { data: this.fastBegin(args), error: null };
      case "fast_record":
        return { data: this.fastRecord(args), error: null };
      case "fast_abandon":
        return { data: this.fastAbandon(args), error: null };
      case "fast_speech_mint":
        return { data: this.fastSpeechMint(args), error: null };
      case "fast_speech_settle":
        return { data: this.fastSpeechSettle(args), error: null };
      default:
        throw new Error(`unexpected rpc ${name}`);
    }
  };
}
