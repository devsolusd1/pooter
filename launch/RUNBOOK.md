# Pooter: roteiro do lançamento na mainnet

Pooter é o nome público da moeda (ticker POOTER). Por dentro, o programa, as pastas e as ferramentas continuam
chamados "hunch", e algumas mensagens das ferramentas ainda dizem "Hunch": é o mesmo programa.

Tudo aqui foi ensaiado num validador local em 16/10/2026, na mesma ordem, com o binário final e o
bytecode real da Meteora (DBC 0.2.2, DAMM v2). Nada foi enviado para devnet ou mainnet. Quem envia na
mainnet é você.

Como rodar: todo comando vai no PowerShell do Windows, assim:

    wsl -e bash -lc 'cd /mnt/c/Users/John/RafinhaProject/hunch/<pasta> && <comando>'

- Sem `SEND=1`, nenhum comando envia nada: mostra o plano e simula.
- `SEND=1` e `STEP` só valem na linha de comando, nunca no `.env`.
- Nenhuma ferramenta mostra chave, caminho de chave ou o endereço do seu RPC.

Binário testado: `hunch.so`, 196.864 bytes, sha256
`face57ddb4950ebf82a787cc5c80266dd2a631353c160e40ee2bfca0eb480f0f`.


## 1. Antes do dia

### 1.1 Arquivos de chave

Guarde todos numa pasta só sua no WSL, por exemplo `~/hunch-keys/`
(`mkdir -p ~/hunch-keys && chmod 700 ~/hunch-keys`). Nunca dentro de `hunch/`, nunca no chat.

| arquivo | variável | para que serve |
|---|---|---|
| dev wallet | `KEYPAIR` | faz o deploy (vira a autoridade de upgrade), inicializa, paga o lançamento, recebe 2,01% de cada trade |
| mint | `MINT_KEYPAIR` | o endereço (CA) do token |
| programa | `PROGRAM_KEYPAIR` | o endereço do programa (Hunch por dentro) |
| crank | `CRANK_KEYPAIR` | paga as taxas do crank (um por servidor) |

Como fazer, na pasta `hunch/launch`:

- **Dev wallet que já existe:** salve a chave exportada (texto base58 do Phantom ou Solflare) num
  arquivo, rode `node import-key.mjs <arquivo exportado> ~/hunch-keys/dev.json <endereço esperado>`
  e apague o arquivo exportado. Ele só imprime o endereço.
- **Chave nova:** `node import-key.mjs --new ~/hunch-keys/<nome>.json` (programa, crank, ou o mint
  se não quiser endereço personalizado).
- **Endereço personalizado (CA ou programa):** `cd ~/hunch-keys && solana-keygen grind --ends-with <fim>:1`.
  O arquivo sai com o nome do endereço. Um final de 3 letras leva segundos; 4 letras, minutos.

Faça uma cópia offline dos arquivos dev e mint. **O mint é para sempre:** o `initialize` amarra o
Hunch a esse endereço, e o Hunch não pode ser inicializado de novo. Para sair disso só há duas saídas:
um upgrade do programa ou um programa novo (cerca de 1 SOL a mais).

### 1.2 O `.env`

Você mesmo escreve `hunch/launch/.env`, uma linha por variável no formato `NOME=valor`. Não cole
nada disso no chat.

- `RPC_URL`: o seu RPC privado.
- `KEYPAIR`: o caminho do arquivo da dev wallet.
- `MINT_KEYPAIR`: o caminho do arquivo do mint.
- `PROGRAM_KEYPAIR`: o caminho do arquivo do programa.
- `TESTED_SHA256`: o sha256 do binário testado (acima). O deploy recusa outro.
- Opcionais:
  - `PRIORITY`: micro-lamports por unidade de computação (padrão 50.000 no lançamento, 20.000 no deploy).
  - `SOL_USD`: o preço do SOL. Sem ele, o preço vem da Jupiter.

`CLUSTER` fica de fora: o padrão já é `mainnet-beta`.

### 1.3 Metadata

Siga `launch/metadata/README.md`:

1. Nome primeiro.
2. Suba `image.png` na Pinata (Public).
3. Preencha `metadata.json` e rode `node metadata.mjs`.
4. Suba o `metadata.json`.
5. Ponha o link em `token.json` → `uri`.
6. Rode `node metadata.mjs --served`. Ele tem que dizer `Nothing to fix.`.

Use o gateway `gateway.pinata.cloud`. Nunca tire os dois arquivos da Pinata (unpin).

### 1.4 Decisões ainda abertas (todas em `launch/token.json`, salvo onde dito)

- **Nome e ticker** (`name`, `symbol`):
  - O ticker tem de 1 a 10 caracteres, só A-Z e 0-9, e fica gravado para sempre no `initialize`. O
    diário nomeia a moeda por ele.
  - O `metadata.json` precisa ter o mesmo nome e símbolo.
  - O site usa `site/config.js` (`name`, `ticker`).
- **Começo em US$ 7 mil e graduação em US$ 40 mil** (`startUsd`, `graduationUsd`): confirme antes do passo 3.
  Com o SOL a US$ 180, a curva gradua com 65,5 SOL dentro dela; a US$ 104, com 113 SOL.
- **Dev buy ou não** (`devBuySol`). Decida **antes do passo 3**, porque a config grava a regra.
  - Com compra, ela vai dentro do passo 4 e paga 3,75%, não os 50% da abertura.
  - Com o `adopt_curve` na mesma transação e um uri de verdade (cerca de 93 caracteres), a transação
    passa do limite (1.247 de 1.232 bytes).
  - A saída é embrulhar o SOL antes (passo 4a). Assim ficam 1.215 bytes, testado.
  - Para mudar `devBuySol` depois do passo 3, apague `pending.mainnet-beta.json` e refaça o passo 3
    (mais 0,006 SOL).
- **Squads para a autoridade de upgrade:** o `initialize` exige a assinatura da autoridade. Então
  transfira só **depois** do passo 2, quando quiser:

      solana program set-upgrade-authority <PROGRAM_ID> --new-upgrade-authority <cofre do Squads> --skip-new-upgrade-authority-signer-check --keypair <dev.json> -u m

  Use o endereço do **cofre** (vault) do Squads, não o da multisig. Depois disso, todo upgrade passa
  pelo Squads.
- **Onde o crank roda 24 horas:** um servidor Linux com systemd (seção 3.1) e um segundo servidor de
  reserva.


## 2. O dia, passo a passo

Rode sempre o plano (sem `SEND`) antes de enviar. Se algo não ficar claro, pare: nada é enviado sem
`SEND=1`. Se um envio terminar como `unknown`, **não reenvie**. Espere um minuto e rode o plano: ele
procura na chain o que aconteceu.

### Passo 0: a Meteora mudou o DBC?

    wsl -e bash -lc 'cd /mnt/c/Users/John/RafinhaProject/hunch/launch && bash dbc-recheck.sh'

Sucesso: `UNCHANGED`. Ele só lê, por um nó público.

Se disser `CHANGED`, pare. Rode `RUN_SUITE=1 bash dbc-recheck.sh` e só siga se passar.

### Passo 1: deploy do programa

    wsl -e bash -lc 'cd /mnt/c/Users/John/RafinhaProject/hunch/scripts && bash deploy-program.sh'
    wsl -e bash -lc 'cd /mnt/c/Users/John/RafinhaProject/hunch/scripts && SEND=1 bash deploy-program.sh'

- **O plano:** compila (`programs/build.sh`) e mostra o sha256, que tem de ser o testado. Mostra
  também quanto SOL a carteira precisa.
- **Sucesso:**
  - `the program on mainnet-beta is byte for byte the build`;
  - `written to program.json for mainnet-beta`;
  - a dev wallet é a autoridade de upgrade.
- **SOL:** pico de cerca de 2,005 SOL durante o deploy. No fim custa cerca de 1,004 SOL; o buffer de
  1,001 SOL volta.
- **Se parar no meio** (rede, saldo):
  - O SOL do buffer não se perde. O erro do `solana` mostra o endereço do buffer e 12 palavras.
  - Para recuperar o SOL: `solana program close <BUFFER> --keypair <dev.json> -u m`. Depois rode o
    plano e o envio de novo.
  - Para continuar de onde parou: `solana-keygen recover -o ~/hunch-keys/buffer.json` (com as 12
    palavras), depois
    `solana program deploy <hunch.so> --buffer ~/hunch-keys/buffer.json --program-id <program.json> --upgrade-authority <dev.json> --keypair <dev.json> --max-len 196864 -u <RPC>`.
  - Se o programa já existir, o script recusa um segundo deploy. Confira com
    `solana program show <PROGRAM_ID> -u m`.

### Passo 2: inicializar o programa (com o ticker POOTER)

    wsl -e bash -lc 'cd /mnt/c/Users/John/RafinhaProject/hunch/scripts && node init-hunch.mjs'
    wsl -e bash -lc 'cd /mnt/c/Users/John/RafinhaProject/hunch/scripts && SEND=1 STEP=initialize node init-hunch.mjs'

- **O plano:** confira o endereço do token (o seu `MINT_KEYPAIR`) e o ticker.
- **Sucesso:** `Done: initialize ...` e `the state holds the ticker <TICKER>`.
- **SOL:** 0,1313 SOL de aluguel de sete contas, mais cerca de 0,00001 de taxa.
- **Se falhar:** é uma transação só, nada fica pela metade; rode o plano de novo. O que não tem
  conserto: o mint ou o ticker errado (veja 1.1). Por isso confira o plano.

### Passo 3: a config da curva (não é pública)

    wsl -e bash -lc 'cd /mnt/c/Users/John/RafinhaProject/hunch/launch && node launch.mjs'
    wsl -e bash -lc 'cd /mnt/c/Users/John/RafinhaProject/hunch/launch && SEND=1 STEP=config node launch.mjs'

- **Sucesso:** `Step 1 is done: the config is on chain`. É criado o `pending.mainnet-beta.json`.
  Ninguém consegue negociar ainda.
- **SOL:** 0,0060 SOL.
- **Se falhar:** sem config criada, ele apaga o `pending`; rode o plano de novo.

### Passo 4: o token (CA público a partir daqui)

4a. Só com dev buy: embrulhe a compra mais o aluguel da conta WSOL (0,00148844 SOL na mainnet) numa
carteira que ainda não tenha conta WSOL. O plano do passo 4 mostra o número exato. Por exemplo, para
0,5 SOL:

    wsl -e bash -lc 'spl-token wrap 0.50148844 <dev.json> --fee-payer <dev.json> -u m'

4b. O plano e o envio:

    wsl -e bash -lc 'cd /mnt/c/Users/John/RafinhaProject/hunch/launch && node launch.mjs'
    wsl -e bash -lc 'cd /mnt/c/Users/John/RafinhaProject/hunch/launch && SEND=1 STEP=token node launch.mjs'

- **O plano tem de dizer:**
  - `Step 2 simulates cleanly ... (createPool + transferPoolCreator + adopt_curve)`, ou com
    `+ the developer's buy`, e quantos bytes;
  - `Hunch adopts it in the same transaction: ... phase curve ... ticker <TICKER>`;
  - com compra: `it paid ... exactly 3.75%`.
- **Sucesso:**
  - `$<TICKER> is live`;
  - `pool creator ... (the budget PDA)`;
  - `Hunch adopted the pool in the same transaction: phase curve`.

  Uma transação só cria o pool, passa o criador para o PDA do orçamento e faz o Hunch adotar o pool.
  Não existe janela em que a curva fique sem dono.
- **SOL:**
  - 0,0221 SOL: aluguel de pool, cofres, mint, metadata e da conta de POOTER do orçamento, mais a taxa
    de 0,01 SOL da Metaplex;
  - com compra, mais a compra e 0,0015 SOL da conta do seu token;
  - o aluguel da conta WSOL (0,0015) volta quando você a fechar:
    `spl-token close --address <conta WSOL> --owner <dev.json> -u m`.
- **Se recusar** com "SOL has moved": o SOL andou mais de 10% desde o passo 3. Apague
  `pending.mainnet-beta.json` e refaça o passo 3.
- **Se falhar:** é atômico, nada é criado e o CA continua livre. Rode o plano de novo.

### Passo 5: conferir

    wsl -e bash -lc 'cd /mnt/c/Users/John/RafinhaProject/hunch/scripts && node init-hunch.mjs'

- **Tem de dizer:** `Hunch is running (phase curve)`.
- Só se disser `phase setup` (não deve acontecer): `SEND=1 STEP=adopt node init-hunch.mjs`, na hora.

### Passo 6: o crank

O ideal é já estar rodando no servidor desde o passo 2 (seção 3.1). Ele espera a adoção sozinho.

Para ver na sua máquina antes (não envia nada):

    wsl -e bash -lc 'cd /mnt/c/Users/John/RafinhaProject/hunch/crank && PROGRAM_ID=<PROGRAM_ID> PAYER=<endereço do crank> RPC_URL=<RPC> node crank.mjs --once'

- **Sucesso no servidor:**
  - a cada 10 minutos, `tick landed`;
  - na virada da hora UTC, o tick com `diary: hour N: ...`;
  - cerca de 20 a 65 s depois, `buy landed`. Na primeira virada depois do lançamento a compra espera
    (`waited (VOLUME_CAP)`): ainda não há uma hora inteira de volume. A primeira compra de verdade vem
    na segunda virada, e a linha do diário que diz `burned ... <TICKER>` sai na virada seguinte.
- **O primeiro tick** só registra a base. A primeira chamada (mais movimentada ou mais calma) vem
  quando já há duas horas de trades.


## 3. Depois do lançamento

### 3.1 O crank no servidor (mais um de reserva)

1. Copie a pasta `hunch/crank` para `/opt/hunch-crank` num Linux com Node 20.
2. Dentro dela, rode `npm install --omit=dev`.
3. Crie um usuário `hunch`, dono da pasta.
4. Ponha o arquivo do crank lá, com `chmod 600`.
5. Escreva `/opt/hunch-crank/.env`, legível só pelo `hunch`:
   - `RPC_URL`: o RPC do servidor;
   - `PROGRAM_ID`: o endereço do programa;
   - `CRANK_KEYPAIR`: o caminho do arquivo do crank;
   - opcionais: `PRIORITY` e `CRANK_LOG` (um arquivo de log);
   - no servidor de reserva, também `TICK_FROM=14`.
6. Ligue o serviço:

       sudo cp hunch-crank.service /etc/systemd/system/ && sudo systemctl enable --now hunch-crank
       journalctl -u hunch-crank -f

- **SOL:**
  - cada chave de crank com 0,1 SOL;
  - o principal gasta cerca de 0,0011 SOL por dia (PRIORITY 20.000), e a reserva quase nada;
  - a cada 92 dias, o `grow_brain_book` custa 0,030 SOL de aluguel.
- **O que o crank faz sozinho:**
  - tick a cada 10 minutos;
  - compra e queima a cada hora;
  - na graduação: `withdraw_surplus`, `claim_curve_fees`, `adopt_pool` e, depois, `claim_pool_fees`
    de hora em hora.
- Os dois cranks juntos não duplicam nada: o programa recusa e eles simulam antes.

### 3.1b O crank neste PC (a escolha de 20/10/2026)

O crank pode rodar aqui mesmo, no WSL, com `crank/run-pc.sh`: ele roda o `crank.mjs` e o liga de novo
se ele parar. Só um por PC. Log no WSL em `~/pooter-crank/crank.log`.

1. Chave do crank: `~/hunch-keys/crank.json` (endereço `AMK1zk2drNixv8Rhr9Xo1ZS6ALCswfm8Qk6ZkQs4auRR`).
   Mande 0,1 SOL para ela.
2. Você escreve `hunch/crank/.env` (nunca no chat):
   - `RPC_URL=` o seu RPC;
   - `CRANK_KEYPAIR=/home/yohn/hunch-keys/crank.json`;
   - `PROGRAM_ID=CCw2e4MgnZ3opEddVX4oJHkWJye81gARqEC1535hPaY1`.
3. Teste sem enviar (Ctrl+C para parar):

       wsl -e bash -lc 'bash /mnt/c/Users/John/RafinhaProject/hunch/crank/run-pc.sh'

4. Depois do lançamento, a tarefa do Windows que liga o crank ao entrar no Windows, sem janela
   (PowerShell, uma vez):

       $a = New-ScheduledTaskAction -Execute "conhost.exe" -Argument '--headless wsl.exe -e bash -lc "bash /mnt/c/Users/John/RafinhaProject/hunch/crank/run-pc.sh send"'
       $t = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
       $c = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
       Register-ScheduledTask -TaskName "Pooter crank" -Action $a -Trigger $t -Settings $c
       Start-ScheduledTask -TaskName "Pooter crank"

   Para parar: `Stop-ScheduledTask -TaskName "Pooter crank"` e
   `wsl -e bash -lc 'pkill -f run-pc.sh; pkill -f crank.mjs'`.

O PC precisa: nunca dormir na tomada (Configurações → Sistema → Energia: suspender "Nunca"), ficar
com você logado (tela bloqueada pode), internet estável. Se ele desligar ou reiniciar perto da virada
da hora, aquela hora conta como perdida no placar; depois de reiniciar, o crank só volta quando você
entrar no Windows. Uma reserva numa VPS (seção 3.1, `TICK_FROM=14`) cobre essas horas.

### 3.2 O site

- Em `site/config.js`, preencha:
  - `programId`;
  - `mint` (o CA);
  - `pool` (o pool DBC que o passo 4 imprime, também em `launched.mainnet-beta.json`);
  - opcional, `developer` (a dev wallet).
- Na Vercel (projeto com a pasta `hunch`; o `vercel.json` já aponta para `site`), crie a variável de
  ambiente `RPC_URL` com o seu RPC. O navegador nunca vê esse endereço. Publique de novo.
- **Conferir:**
  - `https://<site>/api/state` responde;
  - a página sai do modo ensaio e mostra a chamada da hora, o placar e a linha do diário com o seu
    ticker.

### 3.3 Conferir na chain

- `node launch.mjs` (pasta `launch`): criador do pool = PDA do orçamento, Hunch em `phase curve` e
  número de ticks.
- `node init-hunch.mjs` (pasta `scripts`): fase, ticker, ticks.
- `solana program show <PROGRAM_ID> -u m`: autoridade = dev wallet (ou o cofre do Squads), 196.864
  bytes.
- Para conferir o binário de novo:

      solana program dump <PROGRAM_ID> /tmp/h.so -u m && head -c 196864 /tmp/h.so | sha256sum

  Tem de dar `face57dd...0f0f`.
- No Solscan:
  - os ticks do crank de 10 em 10 minutos;
  - o memo de cada virada de hora (`hour N: ...`);
  - nas horas com compra, `bought ... SOL, burned ... <TICKER>`.


## 4. Quanto SOL (mainnet: aluguel de 5.080 lamports por byte, mais 128 bytes por conta)

| passo | fica preso (aluguel) | taxas de rede | observação |
|---|---:|---:|---|
| 1. deploy (ProgramData 196.909 B + programa 36 B) | 1,001781 | até 0,0026 | pico de 2,0053 na carteira: buffer de 1,000907, que volta |
| 2. initialize (7 contas) | 0,131333 | 0,00001 | estado, modelo, fita, chamada, diário, livro do cérebro, WSOL do orçamento |
| 3. config (1.048 B) | 0,005974 | 0,00001 | |
| 4. token + adopt_curve | 0,012070 + 0,01 Metaplex | 0,00002 | pool 424 B, 2 cofres, mint, metadata 607 B, POOTER do orçamento |
| 4. com dev buy | + a compra + 0,001488 (conta do token) | + 0,00001 | + 0,001488 da conta WSOL, que volta ao fechar |
| crank (cada chave) | | cerca de 0,0011 por dia | ponha 0,1 SOL em cada |

Total sem dev buy:

- cerca de 1,164 SOL da dev wallet;
- mais 0,2 SOL para dois cranks;
- comece com pelo menos 2,2 SOL na dev wallet, por causa do pico do deploy.


## 5. O que foi ensaiado e o que não foi

**Ensaiado no validador local** (portas 8940/9940/10060), com chaves descartáveis:

- passo 0;
- deploy (plano e envio, sha conferido de volta);
- initialize com o ticker;
- config;
- token com `adopt_curve` na mesma transação: 1.065 bytes com um uri de 93 caracteres;
- `STEP=adopt` recusando, e um segundo passo 4 recusado;
- o crank seco e três cranks enviando, através de três viradas de hora UTC (23:00, 00:00 e 01:00):
  - 15 ticks, nenhum em dobro;
  - uma espera (limite de volume) e duas compras com queima;
  - o crank de reserva não enviou nada;
  - o memo das 01:00:
    `hour 2: watching, no call yet. bought 0.471 SOL, burned 11.55M POOTER. next: quieter 58/42. brain d6d8d67f`;
- o site em modo live lendo o validador: a chamada, o placar e as linhas do diário iguais aos memos.

Num segundo validador: o dev buy de 0,5 SOL embrulhado antes, a 1.215 bytes. Pagou exatamente 3,75%
e foi adotado na mesma transação. Sem embrulhar antes, foi recusado com 1.247 bytes.

**Não provado:**

- nenhum envio real na mainnet;
- o seu RPC (o crank usa `getTokenAccountBalance`, `getTokenAccountsByOwner` com Token-2022 e
  simulação);
- o tempo real do keeper de migração da Meteora;
- uma compra que de fato troca e queima no pool DAMM v2 depois da graduação (só nos testes LiteSVM);
- a graduação inteira com este crank (o crank anterior fez, num teste de cerca de 2 horas; as
  mudanças de hoje no crank foram checadas por testes unitários e por simulação);
- o uri real da Pinata (medido com um uri local do mesmo tamanho).
