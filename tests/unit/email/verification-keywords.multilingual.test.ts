import { describe, it, expect } from 'vitest';
import { detectFacebookVerificationEmail } from '@/services/email/facebook-detector.service';
import { extractVerificationCode } from '@/services/email/code-extractor.service';

// TASK-069A — Multilingual readiness for Facebook/Meta verification detection.
//
// Every fixture below is SYNTHETIC. No real email body, no real verification
// code, no real recipient. The code `385729` is a made-up 6-digit value used
// only to prove the detector + extractor agree across locales. Negative cases
// use invoice / order / phone noise to prove a number in the wrong context is
// NOT mis-classified or mis-extracted.

const TRUSTED_SENDER = 'security@facebookmail.com';
const SYNTHETIC_CODE = '385729';
const SYNTHETIC_MASKED = '38****';

function recentIso(): string {
  return new Date().toISOString();
}

interface LocaleFixture {
  locale: string;
  // Positive: a genuine-shaped verification email in this language.
  positive: { subject: string; body: string };
  // Negative: trusted sender, brand mentioned, but the number is invoice /
  // order / phone noise — must not be treated as a verification code.
  negative: { subject: string; body: string };
}

const FIXTURES: readonly LocaleFixture[] = [
  {
    locale: 'English',
    positive: {
      subject: 'Your Facebook confirmation code',
      body: `Your Facebook confirmation code is ${SYNTHETIC_CODE}. It expires in 10 minutes.`,
    },
    negative: {
      subject: 'Your Facebook ads receipt',
      body: 'Your Facebook ads invoice 482910 is ready. Order 558392. Phone 0987654321.',
    },
  },
  {
    locale: 'Vietnamese',
    positive: {
      subject: 'Mã xác minh Facebook của bạn',
      body: `Mã xác minh Facebook của bạn là ${SYNTHETIC_CODE}. Mã sẽ hết hạn trong 10 phút.`,
    },
    negative: {
      subject: 'Hóa đơn quảng cáo Facebook',
      body: 'Hóa đơn Facebook 482910 đã sẵn sàng. Đơn hàng 558392. Số điện thoại 0987654321.',
    },
  },
  {
    locale: 'Spanish',
    positive: {
      subject: 'Tu código de confirmación de Facebook',
      body: `Tu código de confirmación de Facebook es ${SYNTHETIC_CODE}. Caduca en 10 minutos.`,
    },
    negative: {
      subject: 'Tu factura de Facebook',
      body: 'Tu factura de Facebook 482910 está lista. Pedido 558392. Teléfono 0987654321.',
    },
  },
  {
    locale: 'Portuguese',
    positive: {
      subject: 'Seu código de confirmação do Facebook',
      body: `Seu código de confirmação do Facebook é ${SYNTHETIC_CODE}. Expira em 10 minutos.`,
    },
    negative: {
      subject: 'Sua fatura do Facebook',
      body: 'Sua fatura do Facebook 482910 está pronta. Pedido 558392. Telefone 0987654321.',
    },
  },
  {
    locale: 'French',
    positive: {
      subject: 'Votre code de confirmation Facebook',
      body: `Votre code de confirmation Facebook est ${SYNTHETIC_CODE}. Il expire dans 10 minutes.`,
    },
    negative: {
      subject: 'Votre facture Facebook',
      body: 'Votre facture Facebook 482910 est prête. Commande 558392. Téléphone 0987654321.',
    },
  },
  {
    locale: 'German',
    positive: {
      subject: 'Dein Facebook-Bestätigungscode',
      body: `Dein Facebook-Bestätigungscode lautet ${SYNTHETIC_CODE}. Er läuft in 10 Minuten ab.`,
    },
    negative: {
      subject: 'Deine Facebook-Rechnung',
      body: 'Deine Facebook-Rechnung 482910 ist fertig. Bestellung 558392. Telefon 0987654321.',
    },
  },
  {
    locale: 'Indonesian',
    positive: {
      subject: 'Kode konfirmasi Facebook Anda',
      body: `Kode konfirmasi Facebook Anda adalah ${SYNTHETIC_CODE}. Berlaku selama 10 menit.`,
    },
    negative: {
      subject: 'Faktur Facebook Anda',
      body: 'Faktur Facebook 482910 sudah siap. Pesanan 558392. Telepon 0987654321.',
    },
  },
  {
    locale: 'Thai',
    positive: {
      subject: 'รหัสยืนยัน Facebook ของคุณ',
      body: `รหัสยืนยัน Facebook ของคุณคือ ${SYNTHETIC_CODE} หมดอายุใน 10 นาที`,
    },
    negative: {
      subject: 'ใบแจ้งหนี้ Facebook',
      body: 'ใบแจ้งหนี้ Facebook 482910 พร้อมแล้ว คำสั่งซื้อ 558392 โทรศัพท์ 0987654321',
    },
  },
  {
    locale: 'Chinese Simplified',
    positive: {
      subject: '你的 Facebook 验证码',
      body: `你的 Facebook 验证码是 ${SYNTHETIC_CODE}，10 分钟内有效。`,
    },
    negative: {
      subject: 'Facebook 发票',
      body: '你的 Facebook 发票 482910 已就绪。订单 558392。电话 0987654321。',
    },
  },
  {
    locale: 'Chinese Traditional',
    positive: {
      subject: '您的 Facebook 驗證碼',
      body: `您的 Facebook 驗證碼是 ${SYNTHETIC_CODE}，10 分鐘內有效。`,
    },
    negative: {
      subject: 'Facebook 發票',
      body: '您的 Facebook 發票 482910 已就緒。訂單 558392。電話 0987654321。',
    },
  },
  {
    locale: 'Japanese',
    positive: {
      subject: 'Facebook 確認コード',
      body: `あなたの Facebook 確認コードは ${SYNTHETIC_CODE} です。10 分間有効です。`,
    },
    negative: {
      subject: 'Facebook 請求書',
      body: 'あなたの Facebook 請求書 482910 の準備ができました。注文 558392。電話 0987654321。',
    },
  },
  {
    locale: 'Korean',
    positive: {
      subject: 'Facebook 확인 코드',
      body: `회원님의 Facebook 확인 코드는 ${SYNTHETIC_CODE}입니다. 10분 동안 유효합니다.`,
    },
    negative: {
      subject: 'Facebook 청구서',
      body: '회원님의 Facebook 청구서 482910 이(가) 준비되었습니다. 주문 558392. 전화 0987654321.',
    },
  },
  {
    locale: 'Arabic',
    positive: {
      subject: 'رمز التحقق من Facebook',
      body: `رمز التحقق الخاص بك في Facebook هو ${SYNTHETIC_CODE}. ينتهي خلال 10 دقائق.`,
    },
    negative: {
      subject: 'فاتورة Facebook',
      body: 'فاتورة Facebook 482910 جاهزة. طلب 558392. هاتف 0987654321.',
    },
  },
  {
    locale: 'Russian',
    positive: {
      subject: 'Ваш код подтверждения Facebook',
      body: `Ваш код подтверждения Facebook: ${SYNTHETIC_CODE}. Он действует 10 минут.`,
    },
    negative: {
      subject: 'Счёт Facebook',
      body: 'Ваш счёт Facebook 482910 готов. Заказ 558392. Телефон 0987654321.',
    },
  },
  {
    locale: 'Ukrainian',
    positive: {
      subject: 'Ваш код підтвердження Facebook',
      body: `Ваш код підтвердження Facebook: ${SYNTHETIC_CODE}. Він діє 10 хвилин.`,
    },
    negative: {
      subject: 'Рахунок Facebook',
      body: 'Ваш рахунок Facebook 482910 готовий. Замовлення 558392. Телефон 0987654321.',
    },
  },
];

describe('Multilingual Facebook/Meta verification — detector', () => {
  for (const fx of FIXTURES) {
    it(`accepts a genuine ${fx.locale} verification email`, () => {
      const result = detectFacebookVerificationEmail({
        from: TRUSTED_SENDER,
        subject: fx.positive.subject,
        bodyText: fx.positive.body,
        receivedAt: recentIso(),
      });
      expect(result.isFacebookVerification).toBe(true);
      expect(result.platform).toBe('facebook_meta');
      expect(result.matchedSignals).toContain('code_pattern_context_match');
      expect(result.confidenceScore).toBeGreaterThanOrEqual(70);
      // Never echo the (synthetic) code back in the detector result.
      expect(JSON.stringify(result)).not.toContain(SYNTHETIC_CODE);
    });

    it(`rejects ${fx.locale} invoice/order/phone noise from a trusted sender`, () => {
      const result = detectFacebookVerificationEmail({
        from: TRUSTED_SENDER,
        subject: fx.negative.subject,
        bodyText: fx.negative.body,
        receivedAt: recentIso(),
      });
      expect(result.isFacebookVerification).toBe(false);
      expect(result.matchedSignals).not.toContain('code_pattern_context_match');
    });
  }
});

describe('Multilingual Facebook/Meta verification — code extractor', () => {
  for (const fx of FIXTURES) {
    it(`extracts the code from a ${fx.locale} body`, () => {
      const result = extractVerificationCode({
        subject: fx.positive.subject,
        bodyText: fx.positive.body,
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.code).toBe(SYNTHETIC_CODE);
        expect(result.maskedCode).toBe(SYNTHETIC_MASKED);
        expect(result.confidence).toBeGreaterThanOrEqual(70);
        // The masked code must never expose the full (synthetic) value.
        expect(result.maskedCode).not.toBe(SYNTHETIC_CODE);
        for (const candidate of result.candidates) {
          expect(candidate.reason).not.toContain(SYNTHETIC_CODE);
          if (candidate.contextSnippet !== undefined) {
            expect(candidate.contextSnippet).not.toContain(SYNTHETIC_CODE);
          }
        }
      }
    });

    it(`does not extract a code from ${fx.locale} invoice/order/phone noise`, () => {
      const result = extractVerificationCode({
        subject: fx.negative.subject,
        bodyText: fx.negative.body,
      });
      expect(result.success).toBe(false);
    });
  }
});

describe('Multilingual readiness — detector and extractor share one vocabulary', () => {
  it('a brand-only number (no code word) is rejected by the detector gate', () => {
    // Brand present and a 6-digit number present, but no "code" word anywhere:
    // the shared CODE_CONTEXT gate must NOT fire on brand proximity alone.
    const result = detectFacebookVerificationEmail({
      from: TRUSTED_SENDER,
      subject: 'Facebook update',
      bodyText: 'Your Facebook profile reference 482910 was updated today.',
      receivedAt: recentIso(),
    });
    expect(result.isFacebookVerification).toBe(false);
    expect(result.matchedSignals).not.toContain('code_pattern_context_match');
  });

  it('brand context alone cannot push invoice noise over the extractor threshold', () => {
    const result = extractVerificationCode({
      subject: 'Facebook',
      bodyText: 'Your Facebook ads invoice 482910 and order 558392 are ready.',
    });
    expect(result.success).toBe(false);
  });
});
