# Pi Bilardo

Pi Network için 8 top bilardo oyunu. Pi Browser'da çalışır, Pi ile giriş ve Pi ile ödeme (kozmetik ıstaka ve çuha) içerir.

## İçerik

| Dosya | Görev |
|---|---|
| `public/index.html` | Oyunun tamamı: fizik ve falso, 8 top kuralları, 3 seviyeli bilgisayar rakip, aynı cihazda ve çevrimiçi 2 kişilik oyun, istatistik, mağaza ve Pi SDK |
| `server.js` | Oyunu sunar, Pi kullanıcısını doğrular, ödemeleri onaylar ve tamamlar, çevrimiçi odaları yönetir (SSE), Pi bildirimleri gönderir, ürün ve istatistikleri kaydeder |
| `.env.example` | Gerekli gizli değişkenler |

Harici paket yok. Node 18 veya üstü yeterli.

```bash
npm start        # http://localhost:3000
```

## Pi'ye bağlama (developers.minepi.com/agents.md sırasıyla)

1. **Uygulamayı kaydet.** Kayıt Pi Developers'ta yapılır, elle ya da Pi MCP sunucusu (`https://developers.minepi.com/mcp`) üzerinden bir ajanla.
   **Staging (Testnet, Test Pi)** ya da **Production (Mainnet, gerçek Pi)** seçilir. Bu seçim kalıcıdır ve sadece Production uygulamalar listelenebilir.
2. **Sandbox testi (Staging).** `development_url` değerini `http://localhost:3000` yap ve `sandbox_url` adresini aç.
   Sunucu gerekli başlıkları zaten gönderiyor:
   - `X-Frame-Options` yok.
   - `frame-ancestors` yalnızca `'self'`, `https://*.pinet.com` ve `https://*.minepi.com`.
   - `connect-src` içinde `https://socialchain.app` var.
   Oyun `localhost`'ta açılınca `Pi.init` otomatik olarak `sandbox: true` ile çalışır.
3. **Cüzdan ve API anahtarı.**
   - Konsolda `wallet_setup_url` adresinden uygulama cüzdanını kur.
   - `settings_url` → API key → *Generate new key* ile anahtar oluştur.
   - Anahtarı barındırma sağlayıcının gizli değişkenlerine **`PI_NETWORK_API_KEY`** adıyla gir. Dosyaya, sohbete ya da istemci koduna asla koyma.
4. **Yayınla.** Uygulamayı herkese açık bir HTTPS adresine yükle (Render, Railway, Fly.io, VPS vb.). Ardından:
   - Konsolda `frontend_url` olarak bu adresi gir.
   - Alan adı doğrulaması için verilen anahtarı **`PI_VALIDATION_KEY`** gizli değişkenine yaz. Sunucu bunu `/validation-key.txt` adresinden sunar.
   - Doğrulama bitince verilen `https://<isim>.pinet.com` adresini Pi Browser'da aç.
5. **Listele (sadece Production).** `listing_url` sayfasını bilgisayarda aç. Logo (1024×1024), ekran görüntüleri, kategori ve dil girilip incelemeye gönderilir.

## Ödeme akışı (kullanıcıdan uygulamaya)

1. İstemci `Pi.createPayment({amount, memo, metadata:{itemId}})` çağırır.
2. `onReadyForServerApproval` → `POST /api/payments/approve`. Sunucu şunları kontrol eder, sonra ödemeyi `POST /v2/payments/{id}/approve` ile onaylar:
   - Ödemenin bu kullanıcıya ait olduğu.
   - Ürünün var olduğu ve tutarın sunucudaki fiyatla aynı olduğu.
   - Kullanıcının ürüne zaten sahip olmadığı.
3. Kullanıcı Pi Browser'da onaylar ve işlem blokzincire yazılır.
4. `onReadyForServerCompletion` → `POST /api/payments/complete` → `POST /v2/payments/{id}/complete {txid}`. Ardından ürün kullanıcıya verilir.
5. Yarım kalan ödemeler girişte `onIncompletePaymentFound` ile sunucuya gönderilir. Sunucu, `txid` varsa ödemeyi tamamlar, yoksa iptal eder.

Fiyatlar `server.js` içindeki `ITEMS` ile `public/index.html` içindeki `ITEMS` arasında aynı tutulmalı. Fiyat kontrolünü her zaman sunucu yapar.

## Oyun özellikleri

- **Falso:** Sol alttaki küçük topa dokunup vuruş noktası seçilir.
  - Üst falso beyaz topu temastan sonra ileri götürür, alt falso geri çeker.
  - Yan falso banttan dönüş açısını değiştirir.
  - Nişan çizgisi beyaz topun falsolu yolunu gösterir. Falso her atıştan sonra ortaya döner.
- **Bilgisayar seviyeleri:** Kolay, Orta ve Zor. Seviye yükseldikçe nişan sapması ve güç hatası azalır. Kolay seviye bazen en iyi vuruşu seçmez. Zor seviye düz vuruşlarda geri çekme falsosu kullanır.
- **İstatistik:** Seviyeye göre galibiyet ve yenilgi, çevrimiçi sonuçlar, galibiyet serisi (en iyisiyle birlikte), atış ve sokulan top sayısı. Cihazda saklanır. Pi ile giriş yapılırsa sunucuda kullanıcıya kaydedilir.
- **Çevrimiçi oda:** "Arkadaşla Oyna" bir oda ve `PI_APP_URL/?room=KOD` davet linki oluşturur. pinet.com linki doğrudan Pi Browser'da açılır.
  - Sırası gelen oyuncu vurur. Atış rakibin ekranında canlı oynatılır, ardından atan tarafın hesapladığı sonuç iki tarafa da uygulanır. Nişan ve beyaz top konumu da canlı aktarılır.
  - Sayfa kapanıp açılsa da oyun kaldığı yerden sürer. Oda 7 gün saklanır.
  - Sıra rakibe geçtiğinde rakip uygulamada değilse Pi Notification Center'a "Sıra sende!" bildirimi gider (`POST /v2/in_app_notifications/notify`). Bunun için kullanıcının girişte `in_app_notifications` iznini vermiş olması gerekir. Bir kullanıcıya günde en fazla 48 bildirim gider.
  - Rakip katıldığında ve oyun bittiğinde de bildirim gider. Oyun bitince "Rövanş" ile yeni oyun başlar. Açılışı bu kez diğer oyuncu yapar.

### Çevrimiçi API

| Uç | Görev |
|---|---|
| `POST /api/login` | Pi accessToken doğrulanır, `sid` oturumu döner |
| `POST /api/rooms` | Oda kurar (`sid`, ilk `state`) |
| `POST /api/rooms/join` | Odaya katılır ya da geri döner (`sid`, `room`) |
| `GET /api/rooms/events?room=&sid=` | SSE: `room`, `presence`, `aim`, `shot`, `state` olayları |
| `POST /api/rooms/aim` | Nişan ve beyaz top konumu (sadece sırası olan) |
| `POST /api/rooms/shot` | Atış (sırası olan, güncel `seq` ile) |
| `POST /api/rooms/state` | Atış sonrası durum; oyun bittiyse `reset:true` ile rövanş |
| `POST /api/stats` | İstatistik kaydı |

Sunucu sıra ve `seq` kontrolü yapar, oda en fazla 2 kişi alır ve bozuk durumu reddeder. Sonucu atış yapan istemci hesapladığı için hileye karşı tam koruma yok. Ödüllü maçlar eklenecekse fiziğin sunucuda doğrulanması gerekir.

### Pi girişi olmadan yerelde test

```bash
ALLOW_GUEST=1 npm start
```

İki ayrı tarayıcı penceresi aç (biri gizli pencere olsun). Birinde "Arkadaşla Oyna"yı seç, verilen linki diğerinde aç. Canlıda `ALLOW_GUEST` kapalı kalmalı.

## Sonraki adımlar

- Oda ücreti ve kimse katılmazsa iade (uygulamadan kullanıcıya ödeme). Bunun için `PI_WALLET_SEED` ve `wallet_address` izni gerekir.
- Pi kullanıcıları arasında liderlik tablosu.
- `data.json` yerine gerçek bir veritabanı (SQLite veya Postgres).
