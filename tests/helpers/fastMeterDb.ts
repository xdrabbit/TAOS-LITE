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
  /** Set when a later burst adopted this row. Content then refuses rewrites. */
  fast_sealed_at: number | null;
}

export interface FakeSpeechSession {
  id: string;
  user_id: string;
  minted_at: number;
  expires_at: number;
  granted_seconds: number;
  /** When the JWT issued for this row dies, or null if none was issued. */
  token_expires_at: number | null;
  reported_seconds: number | null;
  billed_seconds: number;
  settled_at: number | null;
  end_reason: string | null;
}

/** The repeat-window knobs `p_repeat` carries, unpacked. */
interface RepeatKnobs {
  ms: number;
  minChars: number;
  minRatio: number;
  strongChars: number;
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

  /**
   * public.fast_repeat_match, in TypeScript.
   *
   * The one rule in this file worth reading twice, because it is the one the
   * review found a hole in: a prefix may only open an older row once it is
   * long enough, spans a word boundary (or is the whole phrase), and reaches
   * far enough through what it matched.
   */
  repeatMatches(typed: string, stored: string, a: RepeatKnobs): boolean {
    if (typed.length < Math.max(a.minChars, 1)) return false;
    if (!stored.startsWith(typed)) return false;
    if (typed !== stored && !typed.includes(" ")) return false;
    return (
      typed.length >= Math.max(a.strongChars, 1) ||
      typed.length >= Math.ceil(stored.length * Math.max(a.minRatio, 0))
    );
  }

  private repeatKnobs(a: Record<string, unknown>): RepeatKnobs {
    const bag = (a.p_repeat ?? null) as Record<string, number> | null;
    return {
      ms: Math.max(bag?.ms ?? 0, 0),
      minChars: bag?.min_chars ?? 4,
      minRatio: bag?.min_ratio ?? 0.6,
      strongChars: bag?.strong_chars ?? 12
    };
  }

  /** Every settled row this text is a meaningful prefix of, newest first. */
  private repeatHit(
    userId: string,
    typed: string,
    src: string,
    tgt: string,
    auto: boolean,
    knobs: RepeatKnobs,
    excludeId?: string | null
  ): FakeRow | undefined {
    return [...this.rows]
      .reverse()
      .find(
        (r) =>
          r.user_id === userId &&
          r.id !== excludeId &&
          r.translation_text !== "" &&
          this.repeatMatches(typed, r.original_text.trim(), knobs) &&
          ((r.source_lang === src && r.target_lang === tgt) ||
            (auto && r.source_lang === tgt && r.target_lang === src)) &&
          r.created_at >= this.now - knobs.ms
      );
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
    const typed = text.trim();
    const pair = `${src}>${tgt}`;
    const auto = Boolean(a.p_auto);
    const knobs = this.repeatKnobs(a);

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
        // The burst bought its row on its first few letters. Look again now
        // that there is more text: if this is a retype, adopt the older answer
        // and hand this burst's own reservation back.
        if (knobs.ms > 0) {
          const grown = this.repeatHit(userId, typed, src, tgt, auto, knobs, open.rowId);
          if (grown) {
            this.rows = this.rows.filter(
              (r) => !(r.id === open.rowId && r.user_id === userId && r.fast_sealed_at === null)
            );
            grown.fast_sealed_at = grown.fast_sealed_at ?? this.now;
            open.lastSeen = this.now;
            open.rowId = grown.id;
            open.adoptedText = grown.original_text.trim();
            return { ok: true, billed: false, row_id: grown.id, repeat: true };
          }
        }
        open.lastSeen = this.now;
        const row = this.rows.find((r) => r.id === open.rowId && r.user_id === userId);
        if (row) row.original_text = typed;
        return { ok: true, billed: false, row_id: open.rowId };
      }
      if (open.adoptedText.startsWith(typed)) {
        open.lastSeen = this.now;
        return { ok: true, billed: false, row_id: open.rowId, repeat: true };
      }
      // Diverged from what was adopted: a different question now.
    }

    // The visit-long billed set, durably: a settled row this text is a
    // MEANINGFUL prefix of, between these two languages, inside the window.
    if (knobs.ms > 0) {
      const hit = this.repeatHit(userId, typed, src, tgt, auto, knobs);
      if (hit) {
        hit.fast_sealed_at = hit.fast_sealed_at ?? this.now;
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
      original_text: typed,
      translation_text: "",
      engine: "fast",
      fast_sealed_at: null
    });
    this.quickies.set(userId, { pair, lastSeen: this.now, rowId: id, adoptedText: null });
    return { ok: true, billed: true, row_id: id, used: cap >= 0 ? used + 1 : null, cap };
  }

  fastRecord(a: Record<string, unknown>): null {
    const row = this.rows.find((r) => r.id === a.p_row_id && r.user_id === a.p_user_id);
    if (!row) return null;
    // The trigger, mirrored: a sealed row's content is not this caller's to
    // rewrite, however it got hold of the id. Silently dropped, exactly as
    // public.fast_guard_sealed drops it.
    if (row.fast_sealed_at !== null) return null;
    row.source_lang = a.p_source_lang as string;
    row.target_lang = a.p_target_lang as string;
    row.original_text = a.p_text as string;
    row.translation_text = a.p_translation as string;
    row.engine = (a.p_engine as string) || "fast";
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

    // The live-token ceiling, and it is NOT conditioned on p_unlimited: it
    // bounds recognition AUTHORITY, not spend, and a founder's stolen token
    // buys the same Azure minutes as anybody else's. Only checked when a
    // credential would actually be issued — a reservation taken against a
    // token the caller already holds adds nothing to the count.
    const issue = a.p_issue !== false;
    const tokenLimit = (a.p_live_token_limit as number) ?? 6;
    if (issue && tokenLimit > 0) {
      const live = this.speech.filter(
        (s) => s.user_id === userId && s.token_expires_at !== null && s.token_expires_at > this.now
      ).length;
      if (live >= tokenLimit) {
        return { ok: false, reason: "live_tokens", live, limit: tokenLimit };
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
      token_expires_at: issue
        ? this.now + Math.max((a.p_token_ttl_ms as number) ?? 600_000, 0)
        : null,
      reported_seconds: null,
      billed_seconds: 0,
      settled_at: null,
      end_reason: null
    });
    return {
      ok: true,
      session_id: id,
      granted_seconds: grant,
      issued: issue,
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
    // A row whose credential was never issued stops holding a live-token
    // slot. Only the token route passes this, and only on the paths where
    // Azure refused, timed out or was never configured — a settle reported by
    // a browser can free a reservation and never a slot.
    if (a.p_release_token === true) s.token_expires_at = null;
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
