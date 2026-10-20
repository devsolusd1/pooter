# Imagem e metadata do token

- `image.jpg`: a imagem do token que está na Pinata (CID bafkreidojxzeld…thscq), 282 x 282.
- `image.png`: o mascote em 1000 x 1000, feito por `make-mascot-image.mjs`.
- `preview/`: como ela fica em 96, 48 e 32 px, em círculo, sobre fundo escuro e claro. Só para conferir; não sobe.
- `image-brain.png` e `image-brain.svg`: a opção anterior, a foto do cérebro (13 x 13 quadrados com os pesos reais do ensaio). Se preferir ela, suba esta no lugar de `image.png`.
- `metadata.json`: o arquivo que os terminais leem (nome, símbolo, descrição, imagem, site, redes).
- `make-image.mjs`: refaz a opção do cérebro e as prévias (`node make-image.mjs`). Sempre dá o mesmo arquivo.
- `metadata.mjs`: copia nome e símbolo do `../token.json` para o `metadata.json` e confere tudo.

Rode os comandos no WSL, nesta pasta.

## Passo a passo (você mesmo, na sua conta Pinata)

1. **Nome primeiro.** Decida `name` e `symbol` em `../token.json` (nome até 32 bytes, símbolo até 10; letra com acento conta 2). Rode `node metadata.mjs`: ele passa os dois para o `metadata.json`.
2. **Suba a imagem.** Na Pinata: *Upload → File → `image.png`*, na rede **Public** (arquivo *Private* não abre em gateway). Copie o CID (começa com `bafkrei…`).
3. **Preencha o `metadata.json`.** Troque `FILL_IMAGE_CID` pelo CID da imagem:
   `"image": "https://gateway.pinata.cloud/ipfs/<CID da imagem>"`.
   Ponha o endereço do site em `website` (o `external_url` e o `properties.files` são copiados sozinhos). `twitter` e `telegram`: preencha ou apague a linha inteira.
4. Rode `node metadata.mjs`. Só pode sobrar o aviso do `uri` do `token.json`.
5. **Suba o `metadata.json`** do mesmo jeito (Public). Copie o CID.
6. **Ponha o link no `../token.json`**, no campo `uri`:
   `"uri": "https://gateway.pinata.cloud/ipfs/<CID do metadata.json>"`
7. Rode `node metadata.mjs --served`. Tem que dizer `Nothing to fix.`: ele baixa o link e confere que é este JSON e esta imagem. O `launch.mjs` confere de novo antes do passo 2.

## Qual gateway

Use `https://gateway.pinata.cloud/ipfs/<CID>` (testado em 16/10/2026: responde 200, aberto para qualquer site). O gateway da sua conta (`https://<seu-gateway>.mypinata.cloud/ipfs/<CID>`) também funciona, mas fica preso ao plano da conta. **Não use `ipfs.io` nem `dweb.link`**: desde setembro de 2026 eles não entregam mais o arquivo (respondem 429, "service worker gateway only"). O `metadata.mjs` recusa esses dois.

## Depois do lançamento nada muda

O nome, o símbolo e o `uri` ficam gravados para sempre (`metadataCanChange: false`), e o CID não muda. Então:

- nunca apague (unpin) os dois arquivos da Pinata;
- se mudar a imagem, o nome ou qualquer campo **antes** do lançamento, suba de novo: o CID muda, e o link no `token.json` também.
