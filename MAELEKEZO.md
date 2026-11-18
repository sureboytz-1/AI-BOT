# Jinsi ya kuweka bot kwenye Render na kuilink na WhatsApp

## 1. Weka msimbo kwenye GitHub
1. Tengeneza repository mpya (private) kwenye github.com.
2. Pakia faili zote za folda hii (usipakie `node_modules` wala `.env`).

## 2. Deploy kwenye Render
1. Ingia render.com -> **New +** -> **Blueprint**.
2. Chagua repository yako. Render itasoma `render.yaml` na kutengeneza:
   - Web service `whatsapp-bot` (Docker)
   - Database ya Postgres `whatsapp-db` (inahifadhi session ya WhatsApp)
3. Ukiombwa, weka `BOT_PASSWORD` (nenosiri lolote, unaweza kuliacha tupu).
4. Bonyeza **Apply** na subiri build iishe (dakika 5-10).

## 3. Chukua API_KEY
Render Dashboard -> `whatsapp-bot` -> **Environment** -> nakili thamani ya `API_KEY`.

## 4. Link WhatsApp
1. Fungua kwenye browser:
   `https://JINA-LAKO.onrender.com/qr-code?key=API_KEY_YAKO`
2. Kwenye simu: WhatsApp -> **Settings -> Linked devices -> Link a device** -> scan QR.
3. Hakiki: `https://JINA-LAKO.onrender.com/status?key=API_KEY_YAKO` itaonyesha `isConnected: true`.

Kama QR haionekani, subiri sekunde 30 na urefreshe. Angalia pia **Logs** za Render.

## 5. Jinsi ya kutumia bot
- **Sticker:** tuma picha yenye caption `#sticker` (au jibu picha kwa `#sticker`).
- **View once:** jibu ujumbe wa view-once kwa `#dvo`.
  Ukiweka `BOT_PASSWORD`, caption iwe `#dvo password:NENOSIRI`.
- **Kutuma ujumbe kwa API:**
  ```
  curl -X POST https://JINA-LAKO.onrender.com/send/text \
    -H "x-api-key: API_KEY_YAKO" -H "Content-Type: application/json" \
    -d '{"sendTo":"255712345678","message":"Habari!"}'
  ```

## Tahadhari muhimu
- **Plan ya Free ya Render hulala baada ya dakika 15** bila trafiki, na bot haitajibu ujumbe wakati huo.
  Ndiyo maana `render.yaml` imetumia `starter`. Pia database ya Free ya Render hufutwa baada ya siku 30.
- Hii inatumia Baileys (si WhatsApp API rasmi). Kuna hatari ndogo ya namba kufungiwa.
  Usitumie namba yako muhimu, na usitume ujumbe wa spam.
- Usimpe mtu yeyote `API_KEY`. Mtu mwenye nayo anaweza kutuma ujumbe kupitia namba yako.
