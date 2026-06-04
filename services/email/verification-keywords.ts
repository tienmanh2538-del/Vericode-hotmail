// TASK-069A — Shared multilingual keyword source for Facebook/Meta verification
// detection. Both the detector (`facebook-detector.service.ts`) and the code
// extractor (`code-extractor.service.ts`) MUST import their keyword vocabulary
// from this single module so the two layers can never drift: an email the
// detector accepts as Facebook/Meta verification should use the same localized
// "code" vocabulary the extractor relies on to pick the code.
//
// SECURITY: this module contains only language constants. It never holds a real
// verification code, email body, token, or secret. Matching is done by the
// consumers via case-insensitive substring includes, so every Latin keyword
// here is stored lowercase. Non-Latin scripts (Thai, CJK, Arabic, Cyrillic)
// have no case folding and are stored as-is.
//
// Scope (locales supported at minimum before the 5–10 mailbox live beta):
//   English, Vietnamese, Spanish, Portuguese, French, German, Indonesian,
//   Thai, Chinese (Simplified + Traditional), Japanese, Korean, Arabic,
//   Russian, Ukrainian.

export const SUPPORTED_LOCALES = [
  'en',
  'vi',
  'es',
  'pt',
  'fr',
  'de',
  'id',
  'th',
  'zh-Hans',
  'zh-Hant',
  'ja',
  'ko',
  'ar',
  'ru',
  'uk',
] as const;

export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

// Brand names are language-independent and appear in essentially every genuine
// Facebook/Meta email. They are a context signal only — never sufficient on
// their own to classify an email as a verification code.
export const BRAND_KEYWORDS: readonly string[] = ['facebook', 'meta', 'instagram'];

// The localized noun for "code" used immediately around the digits. These are
// the high-recall anchors the detector's code-context gate and the extractor's
// weak signal rely on. For scripts where a one-character "code" token would be
// ambiguous (e.g. Chinese 码 also appears in 号码 "phone number"), a less
// ambiguous multi-character form is used instead.
export const CODE_NOUN_KEYWORDS: readonly string[] = [
  'code', // en, fr, de (lowercased "Code"), nl-like
  'mã', // vi
  'código', // es, pt
  'kode', // id
  'รหัส', // th
  'код', // ru, uk
  '验证码', // zh-Hans verification code
  '驗證碼', // zh-Hant verification code
  'コード', // ja "code" (katakana)
  '코드', // ko "code"
  'رمز', // ar "code"
];

// High-precision "<intent> code" phrases per locale. A match adjacent to the
// digits is the strongest signal both layers use. Kept as full phrases so they
// do not fire on unrelated text.
export const STRONG_VERIFICATION_KEYWORDS: readonly string[] = [
  // en
  'security code',
  'confirmation code',
  'verification code',
  'login code',
  'one-time code',
  'one time code',
  'two-factor code',
  '2fa code',
  'facebook code',
  'meta code',
  // vi
  'mã xác minh',
  'mã xác nhận',
  'mã bảo mật',
  'mã đăng nhập',
  'mã một lần',
  'mã facebook',
  'mã meta',
  'mã xác thực',
  // es
  'código de seguridad',
  'código de confirmación',
  'código de verificación',
  'código de acceso',
  'código de inicio de sesión',
  // pt
  'código de segurança',
  'código de confirmação',
  'código de verificação',
  'código de acesso',
  'código de login',
  // fr
  'code de sécurité',
  'code de confirmation',
  'code de vérification',
  'code de connexion',
  'code à usage unique',
  // de (German compounds are single words)
  'sicherheitscode',
  'bestätigungscode',
  'verifizierungscode',
  'anmeldecode',
  'einmalcode',
  // id
  'kode keamanan',
  'kode konfirmasi',
  'kode verifikasi',
  'kode masuk',
  'kode login',
  'kode sekali pakai',
  // th
  'รหัสความปลอดภัย',
  'รหัสยืนยัน',
  'รหัสเข้าสู่ระบบ',
  'รหัสผ่านครั้งเดียว',
  // zh-Hans
  '验证码',
  '安全码',
  '确认码',
  '登录码',
  '一次性验证码',
  // zh-Hant
  '驗證碼',
  '安全碼',
  '確認碼',
  '登入碼',
  // ja
  '確認コード',
  'セキュリティコード',
  '認証コード',
  'ログインコード',
  'ワンタイムコード',
  // ko
  '확인 코드',
  '보안 코드',
  '인증 코드',
  '로그인 코드',
  '일회용 코드',
  // ar
  'رمز الأمان',
  'رمز التأكيد',
  'رمز التحقق',
  'رمز تسجيل الدخول',
  // ru
  'код безопасности',
  'код подтверждения',
  'код проверки',
  'код входа',
  'одноразовый код',
  // uk
  'код безпеки',
  'код підтвердження',
  'код перевірки',
  'код входу',
  'одноразовий код',
];

// Brand + verification-intent / security context words per locale. Used by the
// extractor ONLY as a modest fallback signal near the candidate when no strong
// keyword matched. It cannot, on its own, push a number over the pass threshold
// (see code-extractor scoring) — this keeps invoice/IP/date noise that merely
// mentions a brand from being mis-extracted.
export const VERIFICATION_CONTEXT_KEYWORDS: readonly string[] = [
  ...BRAND_KEYWORDS,
  // en
  'verify',
  'verification',
  'security',
  'confirm',
  'confirmation',
  'login',
  'log in',
  'sign in',
  'sign-in',
  'two-factor',
  'two factor',
  '2fa',
  // vi
  'xác minh',
  'xác nhận',
  'xác thực',
  'bảo mật',
  'đăng nhập',
  // es
  'verificación',
  'seguridad',
  'confirmación',
  'iniciar sesión',
  'acceso',
  // pt
  'verificação',
  'segurança',
  'confirmação',
  'iniciar sessão',
  'acesso',
  // fr
  'vérification',
  'sécurité',
  'confirmation',
  'connexion',
  // de
  'verifizierung',
  'sicherheit',
  'bestätigung',
  'anmeldung',
  // id
  'verifikasi',
  'keamanan',
  'konfirmasi',
  'masuk',
  // th
  'ยืนยัน',
  'ความปลอดภัย',
  'เข้าสู่ระบบ',
  // zh
  '验证',
  '安全',
  '确认',
  '登录',
  '驗證',
  '確認',
  '登入',
  // ja
  '確認',
  'セキュリティ',
  '認証',
  'ログイン',
  // ko
  '확인',
  '보안',
  '인증',
  '로그인',
  // ar
  'تحقق',
  'تأكيد',
  'تسجيل الدخول',
  // ru
  'подтверждение',
  'безопасность',
  'проверка',
  'вход',
  // uk
  'підтвердження',
  'безпека',
  'перевірка',
  'вхід',
];

// Negative keywords: nearby presence strongly suggests the number is NOT a
// verification code (invoice / ticket / IP / phone / order / reference /
// tracking / address). Extended per locale alongside the positive vocabulary so
// added languages do not raise false positives.
export const NEGATIVE_KEYWORDS: readonly string[] = [
  // en + structural
  'case',
  'ticket',
  'invoice',
  'receipt',
  'phone',
  'tel:',
  'ip:',
  'ipv4',
  'ipv6',
  'address',
  'reference',
  'ref:',
  'order',
  'tracking',
  // vi
  'số điện thoại',
  'điện thoại',
  'hóa đơn',
  'số hóa đơn',
  'đơn hàng',
  'mã đơn',
  // es / pt
  'factura',
  'fatura',
  'pedido',
  'teléfono',
  'telefone',
  'dirección',
  'endereço',
  'referencia',
  'referência',
  // fr
  'facture',
  'commande',
  'téléphone',
  'adresse',
  'référence',
  // de
  'rechnung',
  'bestellung',
  'telefon',
  'adresse',
  'referenz',
  'bestellnummer',
  // id
  'faktur',
  'tagihan',
  'pesanan',
  'telepon',
  'alamat',
  'nomor pesanan',
  // th
  'ใบแจ้งหนี้',
  'คำสั่งซื้อ',
  'โทรศัพท์',
  'ที่อยู่',
  // zh
  '发票',
  '订单',
  '电话',
  '地址',
  '發票',
  '訂單',
  '電話',
  // ja
  '請求書',
  '注文',
  '電話',
  '住所',
  // ko
  '청구서',
  '주문',
  '전화',
  '주소',
  // ar
  'فاتورة',
  'طلب',
  'هاتف',
  'عنوان',
  // ru
  'счет',
  'счёт',
  'заказ',
  'телефон',
  'адрес',
  // uk
  'рахунок',
  'замовлення',
  'телефон',
  'адреса',
];

// Marketing / non-verification signals (detector-side penalty). A localized
// "unsubscribe" / newsletter / receipt cue means the trusted-domain email is a
// digest or invoice, not a verification code.
export const MARKETING_KEYWORDS: readonly string[] = [
  // en
  'receipt',
  'invoice',
  'ads summary',
  'ad summary',
  'weekly report',
  'weekly digest',
  'monthly report',
  'newsletter',
  'unsubscribe',
  'policy update',
  'terms update',
  'promotion',
  // vi
  'hóa đơn',
  'biên lai',
  'bản tin',
  'hủy đăng ký',
  // localized "unsubscribe" / newsletter cues
  'cancelar la suscripción', // es
  'cancelar inscrição', // pt
  'se désabonner', // fr
  'abmelden', // de
  'berhenti berlangganan', // id
  'ยกเลิกการสมัคร', // th
  '退订', // zh-Hans
  '退訂', // zh-Hant
  '配信停止', // ja
  '구독 취소', // ko
  'إلغاء الاشتراك', // ar
  'отписаться', // ru
  'відписатися', // uk
];

// Phrase patterns ("<code> is <digits>" / "<digits> is your code") per locale.
// Used by the extractor as a bonus signal; matching is case-insensitive.
export const CODE_PHRASE_PATTERNS: readonly RegExp[] = [
  // en
  /is your[^.\n]{0,40}code/i,
  /your[^.\n]{0,40}code is\s+\d/i,
  /code is\s+\d/i,
  /code:\s*\d/i,
  // vi
  /của bạn là\s+\d/i,
  /mã[^.\n]{0,40}là\s+\d/i,
  // es / pt
  /código[^.\n]{0,20}(es|é)\s+\d/i,
  /código[^.\n]{0,12}[:：]?\s*\d/i,
  // fr
  /code[^.\n]{0,20}est\s+\d/i,
  // de
  /code[^.\n]{0,20}(lautet|ist)\s+\d/i,
  // id
  /kode[^.\n]{0,20}(adalah|anda)[^.\n]{0,6}\d/i,
  // ru / uk
  /код[^.\n]{0,20}[:：]?\s*\d/i,
  // generic CJK / Thai / Arabic / Korean: localized code noun then digits in a
  // short window
  /(验证码|驗證碼|コード|코드|รหัส|رمز)[^\n]{0,15}\d/u,
];

// ---------------------------------------------------------------------------
// Consumer-facing derived lists. Detector and extractor import these directly
// so both layers share exactly one vocabulary.
// ---------------------------------------------------------------------------

// Detector: subject keyword match (brand / intent / strong phrase / code noun).
export const DETECTOR_SUBJECT_KEYWORDS: readonly string[] = [
  ...VERIFICATION_CONTEXT_KEYWORDS,
  ...STRONG_VERIFICATION_KEYWORDS,
  ...CODE_NOUN_KEYWORDS,
];

// Detector: body keyword match (strong phrase / code noun).
export const DETECTOR_BODY_KEYWORDS: readonly string[] = [
  ...STRONG_VERIFICATION_KEYWORDS,
  ...CODE_NOUN_KEYWORDS,
];

// Detector hard gate: a "code" cue must appear near the digits. Intentionally
// excludes bare brand/context words so a number that merely sits near the word
// "Facebook" is NOT treated as a code (false-positive guard).
export const CODE_CONTEXT_KEYWORDS: readonly string[] = [
  ...STRONG_VERIFICATION_KEYWORDS,
  ...CODE_NOUN_KEYWORDS,
];
