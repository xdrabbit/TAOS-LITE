import { languageNative, type LanguageCode } from "./catalog";

// One sentence per language: "you now read in this language", written IN that
// language.
//
// ── Why a table and not a translation call ─────────────────────────────────
// Tom has now misread /chat's language row three times. The last two fixes
// were words ABOUT the setting — a caption, a "They read:" line, a one-time
// hint — and words about a thing are exactly what he was already ignoring.
// What no label can fake is the SCRIPT: tap HI and Devanagari appears on the
// screen a quarter of a second later. That is not a claim about the setting,
// it IS the setting, visible.
//
// Which is why these are literals and not a call to /api/translate. The proof
// only works if it lands with the thumb still on the pill; a round trip that
// takes a second — or fails on a train, or costs a token on every tap — turns
// the one unfakeable signal into another spinner. A hundred short sentences,
// shipped in the bundle, always render.
//
// ── What they say, and what they don't ─────────────────────────────────────
// Deliberately one plain present-tense clause, no app words, no jargon: the
// person reading it may be a stranger holding a borrowed phone, and it is the
// first sentence of theirs the app has ever shown. Each one names its own
// language the way that language names itself in a sentence, which is often
// NOT the catalog's `native` field standing alone — Polish reads "po polsku",
// Russian "по-русски", Finnish "suomeksi". So the sentences are stored whole
// rather than interpolated from a template; a template would produce a
// grammatically foreign sentence in about a third of the hundred.
//
// The English · Español frame is added by lib/chatLabels.ts and always shows
// alongside, so nobody is ever stranded on a sentence they can't read — and a
// sentence here that turns out clumsy is a clumsy sentence, never a lost
// meaning. Corrections from a native reader are welcome; that is a strictly
// better source than this file's author.
//
// `Record<LanguageCode, string>` is load-bearing: adding a row to the catalog
// without a sentence here fails the build (see the note in catalog.ts).
export const READ_CONFIRMATIONS: Record<LanguageCode, string> = {
  en: "You now read in English",
  es: "Ahora lees en español",
  zh: "你现在阅读中文",
  hi: "अब आप हिन्दी में पढ़ेंगे",
  ar: "أنت تقرأ الآن بالعربية",
  pt: "Agora você lê em português",
  ru: "Теперь вы читаете по-русски",
  ja: "これから日本語で読みます",
  de: "Du liest jetzt auf Deutsch",
  fr: "Vous lisez maintenant en français",
  it: "Ora leggi in italiano",
  ko: "이제 한국어로 읽습니다",
  tr: "Artık Türkçe okuyorsun",
  vi: "Bây giờ bạn đọc bằng tiếng Việt",
  pl: "Teraz czytasz po polsku",
  nl: "Je leest nu in het Nederlands",
  id: "Sekarang kamu membaca dalam bahasa Indonesia",
  bn: "আপনি এখন বাংলায় পড়বেন",
  uk: "Тепер ви читаєте українською",
  fa: "شما اکنون به فارسی می‌خوانید",
  af: "Jy lees nou in Afrikaans",
  sq: "Tani lexoni në shqip",
  am: "አሁን በአማርኛ ያነባሉ",
  hy: "Այժմ դուք կարդում եք հայերեն",
  as: "আপুনি এতিয়া অসমীয়াত পঢ়িব",
  az: "İndi Azərbaycan dilində oxuyursunuz",
  ba: "Хәҙер һеҙ башҡортса уҡыйһығыҙ",
  eu: "Orain euskaraz irakurtzen duzu",
  be: "Цяпер вы чытаеце па-беларуску",
  bs: "Sada čitate na bosanskom",
  br: "Bremañ e lennit e brezhoneg",
  bg: "Сега четете на български",
  my: "သင်သည် ယခု မြန်မာဘာသာဖြင့် ဖတ်ပါမည်",
  yue: "你而家用廣東話閱讀",
  ca: "Ara llegeixes en català",
  hr: "Sada čitate na hrvatskom",
  cs: "Nyní čtete česky",
  da: "Du læser nu på dansk",
  et: "Nüüd loete eesti keeles",
  fo: "Tú lesur nú á føroyskum",
  tl: "Nagbabasa ka na ngayon sa Filipino",
  fi: "Luet nyt suomeksi",
  gl: "Agora les en galego",
  ka: "ახლა ქართულად კითხულობთ",
  el: "Τώρα διαβάζετε στα ελληνικά",
  gu: "હવે તમે ગુજરાતીમાં વાંચશો",
  ht: "Kounye a ou li an kreyòl ayisyen",
  ha: "Yanzu kana karatu da Hausa",
  haw: "Ke heluhelu nei ʻoe ma ka ʻōlelo Hawaiʻi",
  he: "אתה קורא עכשיו בעברית",
  hu: "Mostantól magyarul olvasol",
  is: "Þú lest núna á íslensku",
  jw: "Saiki sampeyan maca nganggo basa Jawa",
  kn: "ಈಗ ನೀವು ಕನ್ನಡದಲ್ಲಿ ಓದುತ್ತೀರಿ",
  kk: "Енді сіз қазақша оқисыз",
  km: "ឥឡូវនេះ អ្នកអានជាភាសាខ្មែរ",
  lo: "ດຽວນີ້ ທ່ານອ່ານເປັນພາສາລາວ",
  la: "Nunc Latine legis",
  lv: "Tagad jūs lasāt latviski",
  ln: "Sikoyo ozali kotánga na lingála",
  lt: "Dabar skaitote lietuviškai",
  lb: "Du liess elo op Lëtzebuergesch",
  mk: "Сега читате на македонски",
  mg: "Mamaky teny malagasy ianao izao",
  ms: "Sekarang anda membaca dalam bahasa Melayu",
  ml: "ഇപ്പോൾ നിങ്ങൾ മലയാളത്തിൽ വായിക്കും",
  mt: "Issa taqra bil-Malti",
  mi: "Kei te pānui koe ināianei i te reo Māori",
  mr: "आता तुम्ही मराठीत वाचाल",
  mn: "Одоо та монголоор уншиж байна",
  ne: "अब तपाईं नेपालीमा पढ्नुहुनेछ",
  no: "Du leser nå på norsk",
  nn: "Du les no på nynorsk",
  oc: "Ara legissètz en occitan",
  ps: "تاسو اوس په پښتو لولئ",
  pa: "ਹੁਣ ਤੁਸੀਂ ਪੰਜਾਬੀ ਵਿੱਚ ਪੜ੍ਹੋਗੇ",
  ro: "Acum citești în română",
  sa: "इदानीं भवान् संस्कृतेन पठति",
  sr: "Сада читате на српском",
  sn: "Iye zvino unoverenga muchiShona",
  sd: "هاڻي توهان سنڌي ۾ پڙهو ٿا",
  si: "දැන් ඔබ සිංහලෙන් කියවනවා",
  sk: "Teraz čítate po slovensky",
  sl: "Zdaj berete v slovenščini",
  so: "Hadda waxaad ku akhrisanaysaa Soomaali",
  su: "Ayeuna anjeun maca dina basa Sunda",
  sw: "Sasa unasoma kwa Kiswahili",
  sv: "Du läser nu på svenska",
  tg: "Акнун шумо ба забони тоҷикӣ мехонед",
  ta: "இப்போது நீங்கள் தமிழில் படிப்பீர்கள்",
  tt: "Хәзер сез татарча укыйсыз",
  te: "ఇప్పుడు మీరు తెలుగులో చదువుతారు",
  th: "ตอนนี้คุณอ่านเป็นภาษาไทย",
  bo: "ད་ལྟ་ཁྱེད་ཀྱིས་བོད་སྐད་ཐོག་ཀློག་གི་ཡོད།",
  tk: "Indi siz türkmençe okaýarsyňyz",
  ur: "اب آپ اردو میں پڑھیں گے",
  uz: "Endi siz oʻzbekcha oʻqiysiz",
  cy: "Rydych chi bellach yn darllen yn Gymraeg",
  yi: "איר לייענט איצט אויף ייִדיש",
  yo: "Nísinsìnyí o ń kà ní Yorùbá"
};

/**
 * The sentence for a code, or — if a language ever reaches here without one,
 * which the type says it cannot — the language's own name, which is still in
 * the right script and still not English. The point is the script; degrade to
 * less of it, never to none of it.
 */
export function readConfirmationNative(code: string): string {
  return READ_CONFIRMATIONS[code as LanguageCode] ?? languageNative(code);
}
