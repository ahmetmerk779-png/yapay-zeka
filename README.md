# Minecraft Groq Bot Paneli (v4)

Senin söylediklerini yapan, Groq ile doğal dil anlayan, web panelli Mineflayer botu.
Bot **kendi kararını vermez**: varsayılan olarak yalnızca açıkça istediğini yapar.

## Kurulum
1. Node.js 18+ kur.
2. Klasör yapısı:
   ```
   server.js  package.json
   public/index.html
   src/ai.js  src/actions.js  src/validate.js  src/bot-instance.js
   src/schematic.js  src/search.js  src/crystal.js
   ```
3. `npm install` -> `npm start` -> http://localhost:3000
4. Panelde bot adı, IP, port, sürüm, sahip adın, Groq anahtarı -> **Bağlan**.
   Anahtar: https://console.groq.com/keys (ya da `GROQ_API_KEY=... npm start`)

## İtaatkâr mod
- "Sadece emirleri yap" (varsayılan açık): istenmeyen ekstra iş yapmaz; eksik alet/malzeme varsa kendi başına toplamaz, sana söyler.
- Kendi başına davranışlar (otomatik savunma, yemek/zırh, başarısızlıkta yeniden planlama) **varsayılan kapalı**, panelden açılır.
- Bot kendiliğinden selam vermez, sohbet etmez; sadece sana (veya adını yazan/whisper atan kişiye) cevap verir.

## Şematikler (farm, ev, redstone)
Panelde **Dosya yükle** ile `.schem` (Sponge v2/v3, WorldEdit), `.litematic` (Litematica) ve `.nbt` (yapı bloğu) yükle.
Eski `.schematic` desteklenmez; WorldEdit/Litematica ile dönüştür.
- "ev.schem'i kur", "ev.schem'in malzemesi ne", "şematikleri listele", "ev.schem'i 90 derece çevirip kur"
- **place modu** (varsayılan): envanterdeki bloklarla kurar. Önce malzemeyi kontrol eder, eksikse kurmaz. Tekrar çalıştırırsan kaldığı yerden devam eder. Yön (merdiven, piston, gözlemci, tekrarlayıcı gecikmesi, duvar torcu, yarım blok) elden geldiğince ayarlanır; çift slab ve bazı durumlar (powered, open vb.) desteklenmez.
- **command modu**: OP isen `/setblock` ve `/fill` ile **tam blok durumlarıyla** kurar (redstone devreleri için en güvenilir yol). Panelde "Sunucu komutları" açık olmalı. Malzeme gerekmez.
- Bağlantıdan indirme: "şu linkten şematik indir: https://.../ev.schem"
- İstersen konumu ver: "ev.schem'i 100 64 -200 noktasına kur".

## Web araması (öğrenme)
Bilmediği bir şeyi sorarsan (ör. "piston kapı nasıl yapılır") bot web'de arar, sonucu okuyup isteğini ona göre yapar; öğrendiklerini `data/knowledge-<bot>.json` dosyasına kaydeder.
Sırayla dener: Groq compound modeli (varsa) -> Minecraft Wiki -> DuckDuckGo. Panelde "Arama modeli"ni `off` yaparsan sadece wiki/DuckDuckGo kullanır.

## Kristal PvP (deneysel)
"Ali ile kristal PvP yap" -> `crystal_pvp`: totem/zırh kuşanır, obsidyen/bedrock üstüne kristal koyar, uygun kristallere vurur, canı azalınca altın elma yer, yakınsa kılıçla vurur. Basit sezgisel bir mantıktır; gerçek oyuncu seviyesinde değildir. **Panelde "Oyunculara saldırı" açık olmalı. Sadece PvP'ye izin veren sunucularda kullan.**

## Diğer
- `make_farm`: önünde çalışan tarla kurar (çapa, su kovası, tohum gerekir). `house`: kapı/pencere/çatı/meşaleli ev kurar.
- Redstone: `place` ile toz, kol, düğme, piston, gözlemci, tekrarlayıcı (`delay`) yerleştirilir; karmaşık devreler için şematik + command modu kullan.
- 63 eylem: hareket, kazma, çiftçilik, balık, savaş, inşa, büyü masası, örs, simya, Nether portalı, sandık, köylü takası, şematik, arama ve daha fazlası. Tam liste `src/validate.js` içindeki `ACTION_DOCS`.

## Güvenlik
- `Sahip` doluysa sadece o emir verir. Panel varsayılan olarak yalnızca bu bilgisayardan açılır (`PANEL_HOST=0.0.0.0` ağa açar; parola yoktur).
- Komutlar sadece yetkili kişiden ve panelde izin verildiyse çalışır; bot OP değilse sunucu reddeder.

## Test
`npm test` -> doğrulama, onarım, şematik okuyucu ve yeni özellik testleri (sunucu gerekmez).

## Bilinen sınırlar
Gerçek sunucuda uzun süre test edilmedi; enchant/anvil/brew/nether_portal/crystal_pvp/make_farm deneyseldir. Redstone devresi tasarlayamaz, hazır şematiği kurar. Şematik place modunda havada asılı bloklar için yaslanacak blok gerekir.
