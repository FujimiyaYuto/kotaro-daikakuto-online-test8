/*
 * online-move.js — Online Phase 2：遠隔プレイヤーによるキャラクター操作実験
 *                  Online Phase 3：GUEST 側 Client-side Prediction（ルミポの移動だけ）
 *                  Online Phase 4：通常攻撃「ぽよんアタック」1 種類だけのオンライン同期（HOST が判定）
 *                  Online Phase 5：GUEST の攻撃の遅延補償（Lag Compensation。HOST が自分の履歴で判定）
 *                  Online Phase 6：コタロの既存必殺技「クラゲ電撃」1 種類を追加（入力・予測・判定・遅延補償）
 *                  Online Phase 7：既存の飛び道具「バブルショット」1 種類を追加（HOST authoritative な Projectile 同期）
 *                  Online Phase 8：既存の「ガード」を追加（押している状態を送るだけ。成立は HOST が既存処理で決める）
 *                  Online Phase 9：KO・3 ストック・リスポーン・無敵・勝敗の同期（すべて HOST authoritative）
 *                  Online Phase 10：READY → カウントダウン → 対戦 → 勝敗 → 再戦 の 1 本の流れ（試合の番号 match gen）
 *
 *   HOST  … コタロ = HOST 本人の通常操作 / ルミポ = GUEST から届いた「入力」で、既存の Fighter 物理をそのまま使って動かす
 *   GUEST … 自分ではゲームを進めない。HOST から届いた状態（位置・向きなど）を少し遅らせて補間表示するだけ（予測なし）
 *
 * HOST authoritative：正しいゲーム状態は HOST だけが決める。GUEST から受け取るのは左・右・ジャンプの入力だけ。
 *
 * ゲーム本体のファイルは変更しない。操作実験の間だけ、外から次のように差し替え、終了時に元へ戻す：
 *   - ルミポの controller（CpuController）→ RemoteInputController（GUEST の入力）       ※ CPU 対戦の AI には触れない
 *   - コタロの controller（InputManager）→ 移動・ジャンプだけを通すフィルター（攻撃・必殺・泡・ガードは無効）
 *   - ストックは Version 1.0 と同じ 3（Phase 8 までは Infinity。Phase 9 で KO・勝敗を有効化）
 *   - game.step（このインスタンスだけ）：HOST は「元の step → 状態送信」、GUEST は「入力送信 → 予測 → 表示 → カメラ」
 *
 * Phase 3（予測）の考え方：
 *   - GUEST は固定ステップ（60 回/秒）ごとに 1 件の入力（番号つき）を HOST へ送る。
 *   - HOST は届いた入力を順番に 1 ステップ 1 件ずつ、既存の Fighter.update() でルミポに適用する（HOST が正解）。
 *     HOST 状態には「どの入力番号まで適用したか（a）」と、ルミポの移動に関わる全ての値（p）を載せる。
 *   - GUEST は同じ入力を、自分の画面用の別の Fighter（同じクラス・同じ移動値・同じステージ）に即座に適用して表示する（予測）。
 *   - HOST 状態が届いたら、予測用 Fighter を HOST の値に置き換え、まだ HOST が適用していない入力（番号 > a）を
 *     もう一度順番に適用し直して「今の予測」を作り直す（reconciliation）。
 *   - 作り直す前と後の差（予測誤差）は、画面の表示位置だけに足して数フレームで消す。大きすぎる時は HOST 状態へ即座に合わせる。
 *   - GUEST から HOST へ送るのは今までどおり入力だけ。予測した位置を HOST が使うことはない。
 *
 * Phase 4（攻撃）の考え方：
 *   - 攻撃も「押した瞬間の回数（ap）」として入力に含めるだけ。攻撃を出せるか・当たったか・ダメージ・吹っ飛びはすべて HOST の既存処理
 *     （Fighter の技処理・Combat.resolve・Knockback）が決める。GUEST は命中を一切判定しない。
 *   - 操作実験の間だけ、両者の通常攻撃を既存の「ぽよんアタック」に揃える（ルミポの技選択をこのインスタンスだけ差し替え。技データは変更しない）。
 *   - 攻撃 ID = その攻撃のもとになった「攻撃を押した入力の番号」。HOST と GUEST の予測で同じ規則で決まるので照合できる。
 *   - GUEST は押した瞬間に予測用ルミポで攻撃を開始して見せる（見た目だけ。当たり判定はしない）。
 *   - HOST で命中したら、命中イベント（mh）と、ダメージ・吹っ飛び後の状態を送る。GUEST は HOST の状態をそのまま使う。
 *
 * Phase 5（遅延補償）の考え方：
 *   - HOST は毎ステップ、コタロの Hurtbox を作るのに必要な値（x, y, 向き, 場にいるか）だけを短いリングバッファに残す。
 *     送った状態の番号 → HOST のステップ番号 の対応も残す。
 *   - GUEST は攻撃を押した入力に「その瞬間、画面のコタロの表示に使っていた HOST 状態の番号と、次の状態までの割合」だけを付ける（座標は送らない）。
 *   - HOST はその番号が本当に自分が送ったものか・未来でないか・古すぎないかを確かめ、「今 − 参照時刻」（巻き戻し量）を上限つきで決める。
 *   - ルミポのぽよんアタックの判定が出ている間だけ、コタロの Hurtbox を「巻き戻し量だけ前の位置」で作って既存の Combat.resolve に渡す。
 *     ゲーム世界（コタロの本当の位置）は巻き戻さない。命中したらダメージ・吹っ飛びは今の HOST の状態に既存処理で適用。
 *   - HOST の攻撃（コタロ → ルミポ）には遅延補償を使わない。
 *
 * Phase 6（クラゲ電撃）の考え方：
 *   - 必殺も「押した瞬間の回数（sp）」として入力に含めるだけ。出せるか（再使用待ち・硬直・被弾中）、startup / active / recovery、
 *     命中・ダメージ・吹っ飛び・ヒットストップは HOST の既存処理（Fighter・Combat・技データ jellyShock）がそのまま決める。
 *   - 操作実験の間だけ、両者の「必殺」を既存のクラゲ電撃に揃える（技選択の差し替え。技データ・Fighter は変更しない）。
 *   - 攻撃 ID = 押した入力の番号 × 2 + 技の種類（0 = ぽよん / 1 = クラゲ電撃）。同じ入力で両方押しても ID が重ならない。
 *   - 遅延補償は「技の種類」ではなく「GUEST の近接攻撃（体の攻撃判定を持ち、飛び道具を出さない技）」に対して働く。
 *     巻き戻し量は押下を HOST が適用した時に 1 回だけ決め、その技の判定が出ている間ずっと同じ量を使う（startup 中も GUEST の画面の
 *     コタロは同じ速さで進むので、「GUEST の画面で判定が出た瞬間に見えていたコタロ」を参照することになる）。
 *   - GUEST の画面の効果音・演出（溜め・放電）は、予測用 Fighter からではなく「表示中の技（攻撃 ID ごとに 1 回）」から出す。
 *     予測の作り直し（同じ入力の再適用）で同じ音・演出が何度も出ない。
 *
 * Phase 7（バブルショット）の考え方：
 *   - 泡も「押した瞬間の回数（bp）」として入力に含めるだけ。技を出せるか・発射（8F 目）・同時 2 個まで・移動・地形・寿命・命中は
 *     HOST の既存処理（Fighter・ProjectileSystem・Combat・KG.PROJECTILES.bubble）がそのまま決める。
 *   - HOST は自分の泡にオンライン用の Projectile ID を付け、30Hz の状態に「場にある泡」（ID・発射した側・位置・向き・経過ステップ・攻撃 ID）を載せ、
 *     消えた時は消滅イベント（pe：ID・理由・位置・HOST 時刻）を 1 回送る。消えた ID は GUEST で二度と表示しない。
 *   - GUEST は自分の泡を予測で出す（技の 8F 目。攻撃 ID で仮に識別）。HOST の泡が届いたら同じ攻撃 ID の予測泡に ID を引き継ぎ、
 *     発射位置の差だけを短時間で寄せる。HOST で出なかった予測泡はすぐ薄く消す。予測泡は見た目だけ（命中・消滅を決めない）。
 *   - コタロ（HOST）の泡と、予測していない泡は、コタロと同じ補間の時刻（70ms 前）で表示する（速度一定なので位置は計算で出す）。
 *   - 泡には遅延補償を使わない（HOST の世界を進む authoritative な物体として、今の状態で判定）。
 *
 * Phase 8（ガード）の考え方：
 *   - ガードは「押しているか（g = 0/1）」という状態として毎回の入力に載せるだけ。成立するか（地上・出始め 3F の後・正面から）・押し戻し・
 *     ガード硬直・ヒットストップは HOST の既存処理（Fighter のガード・Combat.resolve の canGuardAgainst）がそのまま決める。
 *   - GUEST は同じ入力を予測用ルミポに適用するので、押した次のフレームからガードの姿勢が見える（見た目と操作感のため。防げたかは決めない）。
 *   - HOST はガード成立を命中イベントと同じ番号の列（mh に g=1）で 1 回だけ送る。1 つの攻撃は既存の hitVictims で HIT か GUARD のどちらか一方だけ。
 *   - ガードの巻き戻し（ガード用の遅延補償）・rollback はしない。近接攻撃の遅延補償は「当たる位置」だけで、ガードできるかは HOST の今の状態で判定。
 *
 * Phase 9（KO・ストック・勝敗）の考え方：
 *   - ストックは Version 1.0 と同じ 3（KG.CONFIG.rules）。場外・ストック -1・約 1 秒後のリスポーン・ダメージ 0・約 2 秒の無敵は
 *     HOST の既存 StockRules がそのまま決める（数値は変更しない）。GUEST は KO・ストック・勝敗を一切自分で決めない。
 *   - HOST は KO ごとに KO イベント（mk：KO 番号・どちらが・残りストック・その側の KO 回数・場外の位置・試合結果）を 1 回送る。
 *     状態 st にも両者の残りストックと KO 回数、試合結果（r）を毎回載せる（イベントが遅れても状態で必ずそろう）。
 *   - GUEST は KO 番号ごとに 1 回だけ演出・音を出し、ストックは HOST の値（絶対値）をそのまま使う。自分で引き算しないので、
 *     同じ KO が何度届いてもストックは二重に減らない。
 *   - リスポーンは「KO 回数（命の番号）が変わった」ことで分かる明確な状態遷移として扱う。予測用ルミポを HOST の状態に置き換え、
 *     死亡前の予測（見た目だけの技・予測泡・表示のずれ・被弾補正）を捨てる。補間は命の番号が違う状態の間では行わない。
 *   - 試合終了（どちらかのストック 0）は HOST が同じステップの KO をまとめてから確定する。同じステップで両者が最後のストックを失ったら
 *     引き分け（DRAW）。終了後は既存の 'ending' → 'result' の流れ（入力は捨てる・戦闘判定なし・泡は消す）で、遅れて届いた入力・泡・命中で
 *     ストック・ダメージ・勝者は変わらない（終了後の場外はストックを減らさず表示から外すだけ）。
 *
 * Phase 10（試合の流れ）の考え方：
 *   - 接続画面（ロビー）で両方が READY（rd / ml の s=0。状態なので重複しても同じ）→ HOST が確認して既存の ms / mr でゲーム画面へ。
 *   - 試合ごとに HOST が match gen（m）を決める。段階（カウントダウン / 対戦 / 決着直後 / 勝敗表示）は既存の Game.phase を HOST が進め、
 *     ml（段階・GO までの残り・再戦希望）を段階が変わった時と 0.5 秒ごとに送る。GUEST は自分では段階を進めない。
 *   - カウントダウン：HOST の時刻 + GO までの残りを Ping の時計のずれで GUEST の時計に直して 3 / 2 / 1 をそろえる。START!（操作開始）は
 *     HOST の GO の確定を受けてから。カウントダウン・決着後・勝敗表示中は、GUEST は何も押していない入力だけを送り予測もしない
 *     （押した回数も増やさない）。HOST は既存の Game.step がその間の入力を捨て、さらに「今の試合の対戦中」でない入力を何も押していない扱いにする。
 *   - 試合の状態の初期化は既存の startMatch（resetTest）。ネットワーク側（予測・未確認入力・補間の履歴・予測泡・消えた泡の記録・命中 / KO の記録・
 *     勝敗）は試合ごとに作り直す。入力番号・押した回数・状態番号・命中番号・泡の ID・KO 番号は接続中ずっと増え続ける（試合をまたいで重ならない）。
 *   - st / mh / mk / pe / ma / mi に m を付け、GUEST は今の試合の番号でない受信を使わない（前の試合の遅れたパケットが新しい試合に影響しない）。
 *   - 勝敗表示の「もう一度」を両方が押したら（GUEST は rd に終わった試合の番号を付ける）HOST が次の match gen を始める。「終了する」は既存の終了（me）。
 */
(function (KG) {
  'use strict';

  const CFG = {
    stateEverySteps: 2,       // HOST → GUEST 状態送信：ゲームの固定ステップ（60/秒）の 2 回に 1 回 = 30Hz
    inputTimeoutMs: 500,      // HOST：これ以上新しい入力が届かなければルミポの入力をニュートラルへ
    maxInputsPerSec: 150,     // HOST：1 秒あたりこれを超える入力メッセージは無視（通常は 60。タブ復帰時のまとめ送りに余裕）
    // ---- Phase 3：HOST の入力キュー ----
    hostQueueTarget: 3,       // HOST：未適用の入力がこれより多い時は 1 ステップで 2 件適用して追いつく（HOST 側の遅れを 約 50ms までに）
    hostQueueMax: 30,
    hostDrainTicks: 30,       // HOST：未適用が 2 件以上のまま この ステップ数 続いたら 1 件追いつく（Phase 4）         // HOST：未適用の入力の上限（あふれた分は古い順に捨てる）
    // ---- Phase 3：GUEST の予測と補正（単位はゲーム内の座標。ルミポの幅 70、地上の最高速度 340/秒 = 1 ステップ 約 5.7）----
    maxPending: 180,          // GUEST：未確認入力の上限（3 秒分）。超えたら古い順に捨てる
    errIgnore: 0.5,           // これ未満の誤差は「補正」として数えない（表示上は見えない大きさ。同じ方法で静かに吸収）
    errSmall: 24,             // 〜これ：小さい誤差（約 4 ステップ分の移動）→ ゆっくり（時定数 80ms）吸収
    errSnap: 120,             // 〜これ：大きい誤差 → 速め（時定数 40ms）に吸収 / これ以上：HOST 状態へ即座に合わせる（snap）
    tauSmallMs: 80,
    tauLargeMs: 40,
    // ---- Phase 4：攻撃 ----
    attackRejectTicks: 14,    // HOST：攻撃の押下から この ステップ数 以内に攻撃が始まらなければ「出せなかった」扱い（先行入力 0.1 秒 + ヒットストップ 7F + 余裕。Phase 6 で 8 → 14）
    hitTauMs: 30,             // GUEST：被弾・命中による差は速め（30ms）に吸収（HOST の被弾結果を優先）
    hitSnap: 300,             // GUEST：被弾・命中による差がこれ以上なら即座に HOST へ
    attackResultTimeoutMs: 1500, // GUEST：予測した攻撃に HOST の結果がこの時間来なければ「HOST で出なかった」と数える
    // ---- Phase 5：遅延補償 ----
    lagMaxMs: 200,            // HOST：巻き戻しの上限（ms）。人工遅延テストの結果から決めた値（docs/ONLINE_PHASE5.md）。URL の ?lagmax= で実験用に変更可（0〜300）
    histTicks: 36,            // HOST：コタロの履歴を残すステップ数（36 = 600ms。上限 200ms + 余裕）
    sentStates: 40,           // HOST：送った状態の番号 → ステップ番号 を残す数（40 件 = 約 1.3 秒）
    interpDelayMs: 70,        // GUEST：表示補間の遅れ（30Hz の状態 約 2 回分）
    maxExtrapolateMs: 100,    // GUEST：新しい状態が遅れた時に速度で先へ伸ばす上限
    snapDistance: 400,        // GUEST：これ以上離れた 2 つの状態の間は補間せず切り替える（リスポーンなど）
    startAckTimeoutMs: 4000,  // HOST：開始の合図に GUEST が応えるまでの上限
    stateStallMs: 1000,       // GUEST：HOST の状態がこれ以上届かなければ警告表示
    stickThreshold: 0.3,      // GUEST：スティック／キーの倒し量をオン・オフに変える境目
  };
  const STATES = ['idle', 'run', 'jump', 'fall', 'attack', 'hurt'];
  // Phase 10：試合の段階（既存の Game.phase）の番号。0 = ロビー（接続画面・READY）/ 1 カウントダウン / 2 対戦 / 3 決着直後 / 4 勝敗表示
  const MT_CODE = { countdown: 1, fight: 2, ending: 3, result: 4 };
  const MT_NAME = ['lobby', 'countdown', 'fight', 'ending', 'result'];
  const BLOCKED_ACTIONS = [];   // Phase 8：攻撃・必殺・泡・ガードをすべて通す（以前の Phase で外していたもの）
  const GUARD_STATES = ['none', 'startup', 'active', 'stun'];   // Fighter.guardState（Phase 8：状態に番号で載せる）
  const POYON = () => KG.MOVES.poyonAttack;
  const JELLY = () => KG.MOVES.jellyShock;
  const BUBBLE = () => KG.MOVES.bubbleShot;
  const BUBBLE_DEF = () => KG.PROJECTILES.bubble;
  // 技の種類（攻撃 ID ÷ 4 の余り）：0 = ぽよんアタック / 1 = クラゲ電撃 / 2 = バブルショット（Phase 7 で ×2 → ×4）
  const KIND_NAMES = ['ぽよん', 'クラゲ電撃', 'バブル'];
  const kindOfMove = (m) => (!m ? 0 : m.id === 'jellyShock' ? 1 : m.id === 'bubbleShot' ? 2 : 0);
  const moveOfKind = (k) => (k === 1 ? JELLY() : k === 2 ? BUBBLE() : POYON());
  const aidOf = (seq, kind) => seq * 4 + kind;
  const kindOfAid = (aid) => aid % 4;
  const SEQ_KEYS = ['lastPressSeq', 'lastSpecialSeq', 'lastShootSeq'];   // 技の種類ごとの「最後に押した入力の番号」
  const DEATH_CODES = { hit: 0, terrain: 1, lifetime: 2, out: 3 };       // 泡が消えた理由（消滅イベント pe の r）
  const DEATH_NAMES = ['hit', 'terrain', 'lifetime', 'out', 'other'];
  // 遅延補償の対象になる技：体の攻撃判定を持ち、飛び道具を出さない近接攻撃（ぽよんアタック・クラゲ電撃）
  const isLagCompMove = (m) => !!m && m.hitboxes.length > 0 && !m.spawns;
  // 技が「出る」最初のフレーム（攻撃判定の開始 / 飛び道具を出すフレーム）
  const firstActive = (m) => Math.min.apply(null, m.hitboxes.map((h) => h.start).concat((m.spawns || []).map((q) => q.frame)));
  // 技の効果音（audio.js の MOVE_SOUNDS と同じ対応。GUEST の表示だけで使う。音そのものは既存の効果音）
  const MOVE_SE = { poyonAttack: { start: 'poyonSwing' }, jellyShock: { start: 'shockCharge', frames: { 10: 'shockZap' } } };
  const HIT_SE = { poyonAttack: 0.7, jellyShock: 0.8 };
  // 操作実験中だけ使う技選択：通常攻撃 = ぽよんアタック、必殺 = クラゲ電撃、それ以外の技は出ない（既存の技データ・Fighter はそのまま）
  function onlineSelectMove(kind) { const k = kind || 'Neutral'; return k === 'Neutral' ? POYON() : k === 'Special' ? JELLY() : k === 'Shoot' ? BUBBLE() : null; }
  // 今の技の攻撃 ID（HOST の RemoteInputController と GUEST の予測で同じ規則）
  function aidFor(f) {
    const a = f.action;
    if (!a) return 0;
    const k = kindOfMove(a.move);
    return aidOf(f[SEQ_KEYS[k]] || 0, k);
  }
  // クラゲ電撃の再使用待ち：HOST は「待ちが始まってからのステップ数」を送り、GUEST は同じ引き算を繰り返して全く同じ値を作る
  function cdSteps(f, move) {
    const v = f.cooldowns[move.id];
    if (!v) return -1;
    return Math.max(0, Math.round((move.cooldown - v) / KG.CONFIG.fixedStep));
  }
  function cdValue(move, n) {
    let c = move.cooldown;
    for (let i = 0; i < n && c > 0; i++) c = Math.max(0, c - KG.CONFIG.fixedStep);
    return c;
  }
  // GUEST：予測用 Fighter を進める間は効果音を鳴らさない（作り直しで同じ入力を何度も適用するため。音は表示側で 1 回だけ鳴らす）
  const NOOP = () => {};
  function quietly(fn) {
    const snd = KG.sound;
    if (!snd) return fn();
    const own = Object.prototype.hasOwnProperty.call(snd, 'play');
    const keep = snd.play;
    snd.play = NOOP;
    try { return fn(); } finally { if (own) snd.play = keep; else delete snd.play; }
  }
  const NO_VICTIMS = new Set();
  // 技 act のこのフレームの攻撃判定（Fighter.getActiveHitboxes と同じ計算。技が被弾で消えた後でも使えるように act を渡す）
  function activeHitboxes(f, act) {
    if (!act) return [];
    const out = [];
    for (const hb of act.move.hitboxes) if (act.frame >= hb.start && act.frame <= hb.end) out.push({ rect: KG.util.orientBox(f.x, f.y, f.facing, hb), data: hb });
    return out;
  }
  function overlapAny(hbs, rects) {
    if (!rects) return false;
    for (const hb of hbs) for (const r of rects) if (KG.util.rectsOverlap(hb.rect, r)) return true;
    return false;
  }
  // 攻撃判定と Hurtbox の横の距離（重なっていれば 0）。「どれだけ逃げていたか」の目安
  function gapBetween(hbs, rects) {
    let best = Infinity;
    for (const hb of hbs) for (const r of rects) {
      const a = hb.rect;
      const dx = Math.max(0, Math.max(a.x, r.x) - Math.min(a.x + a.w, r.x + r.w));
      const dy = Math.max(0, Math.max(a.y, r.y) - Math.min(a.y + a.h, r.y + r.h));
      best = Math.min(best, Math.hypot(dx, dy));
    }
    return best === Infinity ? 0 : best;
  }
  const now = () => performance.now();
  const r1 = (v) => Math.round(v * 10) / 10;
  const lerp = (a, b, k) => a + (b - a) * k;

  // Phase 9 / 10：KO・ストック・勝敗の 1 試合分の状態（[0] コタロ / [1] ルミポ）。result = 0 試合中 / 1 コタロの勝ち / 2 ルミポの勝ち / 3 引き分け
  //   HOST：seq = KO 番号（接続中ずっと増える。試合をまたいでも重ならない）/ stepKOs = このステップの KO（ステップの終わりに送る）/ finals = このステップで最後のストックを失った側
  //   GUEST：ids = 受け取った KO 番号（重複は捨てる）/ stocks・count = HOST の値 / life = 予測用ルミポの命の番号（= KO 回数）
  function newKO(seq) {
    const n = KG.CONFIG.rules.stocks;
    return { over: false, result: 0, seq: seq || 0, count: [0, 0], stocks: [n, n], stepKOs: [], finals: [],
      ids: new Set(), events: 0, dup: 0, respawns: [0, 0], life: 0, lateInputs: 0, lateHits: 0, endAt: 0 };
  }
  // Phase 10：最後のストックを失った側（同じ HOST ステップの分）→ 試合結果。勝敗の規則はここだけ
  //   今の規則：1 人だけ → その相手の勝ち / 同じステップで 2 人とも → 引き分け（Phase 9。サドンデスなどに変える時はここを変える）
  function resultFor(losers, game) {
    if (!losers.length) return 0;
    if (losers.length >= 2) return 3;
    return losers[0] === game.player ? 2 : 1;
  }

  // 直近 1 秒間の回数から Hz を出す
  class RateMeter {
    constructor() { this.n = 0; this.t0 = now(); this.hz = 0; }
    hit() { this.n++; this.roll(); }
    roll() {
      const t = now(), d = t - this.t0;
      if (d >= 1000) { this.hz = (this.n * 1000) / d; this.n = 0; this.t0 = t; }
    }
    get value() { this.roll(); return this.hz; }
  }
  // 平均（指数移動平均）と最大
  class Stat {
    constructor() { this.avg = null; this.last = null; this.max = null; this.n = 0; }
    add(v) { this.last = v; this.n++; this.avg = this.avg == null ? v : this.avg + (v - this.avg) * 0.1; this.max = this.max == null ? v : Math.max(this.max, v); }
  }
  // 単純平均と中央値（件数が少ない診断用。直近 500 件）
  class Samples {
    constructor() { this.v = []; }
    add(x) { this.v.push(x); if (this.v.length > 500) this.v.shift(); }
    get n() { return this.v.length; }
    get mean() { return this.v.length ? this.v.reduce((a, b) => a + b, 0) / this.v.length : null; }
    get median() { if (!this.v.length) return null; const s = this.v.slice().sort((a, b) => a - b); return s[s.length >> 1]; }
    get max() { return this.v.length ? Math.max.apply(null, this.v) : null; }
  }

  // ---------------- HOST：ルミポを GUEST の入力で動かす controller ----------------
  // 既存の CpuController と同じ「1 ステップに 1 回 poll() でコマンドを返す」形。Fighter 側は入力元を区別しない。
  // Phase 3：届いた入力（GUEST の 1 ステップ分ずつ）を順番に並べ、HOST の 1 ステップに 1 件ずつ適用する。
  //   GUEST が予測で行う計算と同じ順番・同じ入力になるので、通常は予測とぴったり一致する。
  class RemoteInputController {
    constructor(fighter, stage) { this.isAI = false; this.fighter = fighter; this.stage = stage; this.resetAll(); }
    resetAll() {
      this.queue = [];                 // 届いたがまだ適用していない入力
      this.lastSeq = 0;                // 受信済みの最新番号
      this.lastJp = 0;
      this.lastApplied = 0;            // 適用済みの最新番号（HOST 状態に「a」として載せる）
      this.last = { mx: 0, hj: 0, hg: 0 };    // 最後に適用した入力（次が届くまではこれを続ける。ガードを押している状態も）
      this.lastAt = 0; this.neutral = true;
      this.dupTicks = 0; this.catchUps = 0; this.overflow = 0;
      this.lastAp = 0; this.lastSp = 0; this.lastBp = 0;
      this.lastPressSeq = 0;           // 最後に適用した「攻撃を押した」入力の番号（攻撃 ID の元）
      this.lastSpecialSeq = 0;         // 最後に適用した「必殺を押した」入力の番号（Phase 6）
      this.lastShootSeq = 0;           // 最後に適用した「泡を押した」入力の番号（Phase 7）
      this.presses = [];               // 適用した押下 { s, kind, ts, tick, lag }（技が始まったか・出せなかったかの集計用）
      this.tick = 0;
    }
    reset() { /* game.resetTest() から呼ばれる。受信状態は保持（開始時に resetAll 済み） */ }
    // Phase 10：新しい試合の開始。未適用の入力・押しっぱなしの状態・押下の記録を捨てる。
    //   入力番号と押した回数の累計（lastSeq / lastJp / lastAp …）は接続中ずっと増え続ける値なので残す（試合ごとに戻さない）
    resetMatch() {
      this.queue = [];
      this.last = { mx: 0, hj: 0, hg: 0 };
      this.neutral = true;
      this.presses = [];
      this.standing = 0;
    }
    // 検証済みの入力メッセージを受け付ける。古い・重複・逆順の番号は捨てる（操作状態が巻き戻らない）
    // Phase 10：neutral = 今の試合（match gen）の入力ではない → 番号と回数の記録だけ進め、何も押していない入力として並べる
    accept(msg, t, neutral) {
      if (msg.s <= this.lastSeq) return 'stale';
      if (msg.jp < this.lastJp || msg.ap < this.lastAp || msg.sp < this.lastSp || msg.bp < this.lastBp) return 'bad';   // ジャンプ・攻撃・必殺・泡の回数は減らない
      const pj = msg.jp > this.lastJp ? 1 : 0;           // 押した瞬間（GUEST の 1 ステップで押せるのは 1 回）
      const pa = msg.ap > this.lastAp ? 1 : 0;           // 攻撃を押した瞬間（同上。押しっぱなしでは増えない）
      const ps = msg.sp > this.lastSp ? 1 : 0;           // 必殺を押した瞬間（Phase 6。同上）
      const pb = msg.bp > this.lastBp ? 1 : 0;           // 泡を押した瞬間（Phase 7。同上）
      this.lastSeq = msg.s; this.lastJp = msg.jp; this.lastAp = msg.ap; this.lastSp = msg.sp; this.lastBp = msg.bp; this.lastAt = t; this.neutral = false;
      const ref = pa || ps;
      if (neutral) this.queue.push({ s: msg.s, mx: 0, hj: 0, hg: 0, pj: 0, pa: 0, ps: 0, pb: 0, ts: msg.ts });
      else this.queue.push({ s: msg.s, mx: (msg.r ? 1 : 0) - (msg.l ? 1 : 0), hj: msg.j, hg: msg.g, pj, pa, ps, pb, ts: msg.ts, rs: ref ? msg.rs : undefined, rf: ref ? msg.rf : undefined });
      if (this.queue.length > CFG.hostQueueMax) {        // あふれたら古い入力を捨てる（押した瞬間は次へ持ち越す）
        const d = this.queue.shift();
        this.overflow++;
        this.lastApplied = d.s;
        const q0 = this.queue[0];
        if (d.pj) q0.pj = 1;
        if (d.pa) q0.pa = 1;
        if (d.ps) q0.ps = 1;
        if (d.pb) q0.pb = 1;
        if ((d.pa || d.ps) && q0.rs == null) { q0.rs = d.rs; q0.rf = d.rf; }
      }
      return 'ok';
    }
    setNeutral() { this.queue.length = 0; this.last = { mx: 0, hj: 0, hg: 0 }; this.neutral = true; }
    toCmd(c) {
      const cmd = KG.createEmptyCommand();
      cmd.moveX = c.mx;                 // 左右同時は GUEST 側で片方に決まっている（-1 / 0 / 1）
      cmd.held.jump = !!c.hj;
      cmd.held.guard = !!c.hg;          // Phase 8：ガードは押している間ずっと（状態）。成立するかは既存の Fighter の規則
      cmd.pressed.jump = !!c.pj;        // 押した瞬間 = その 1 ステップだけ
      cmd.pressed.attack = !!c.pa;      // 攻撃も押した瞬間だけ（出せるかどうかは既存の Fighter の規則）
      cmd.pressed.special = !!c.ps;     // 必殺も押した瞬間だけ（Phase 6。再使用待ち・硬直などは既存の Fighter の規則）
      cmd.pressed.shoot = !!c.pb;       // 泡も押した瞬間だけ（Phase 7。同時 2 個まで・再使用待ちなどは既存の規則）
      return cmd;
    }
    // 入力を 1 件適用する直前の記録（攻撃押下の番号）
    noteApplied(c) {
      if (c.hg && !this.last.hg && this.onGuard) this.onGuard(c);   // Phase 8：ガードを押し始めた入力を HOST が適用した（診断：届くまでの時間）
      this.lastApplied = c.s; this.last = c;
      const f = this.fighter;
      if (c.pb) { this.lastShootSeq = f.lastShootSeq = c.s; this.presses.push({ s: c.s, kind: 2, ts: c.ts, tick: this.tick, lag: null }); }   // 泡：遅延補償なし
      if (!c.pa && !c.ps) return;
      // 攻撃・必殺の押下：Phase 5 の巻き戻し量はこの瞬間（HOST が押下を適用した時）に 1 回だけ決める（同じ入力で両方押しても 1 回）
      const lag = this.onPress ? this.onPress(c) : null;
      if (c.pa) { this.lastPressSeq = f.lastPressSeq = c.s; this.presses.push({ s: c.s, kind: 0, ts: c.ts, tick: this.tick, lag }); }
      if (c.ps) { this.lastSpecialSeq = f.lastSpecialSeq = c.s; this.presses.push({ s: c.s, kind: 1, ts: c.ts, tick: this.tick, lag }); }
    }
    poll() {
      const q = this.queue;
      if (!q.length) {
        // 次の入力がまだ届いていない：直前の入力（押しっぱなしの状態）を続ける。押した瞬間は繰り返さない
        if (!this.neutral) this.dupTicks++;
        return this.toCmd({ mx: this.last.mx, hj: this.last.hj, hg: this.last.hg, pj: 0, pa: 0, ps: 0, pb: 0 });
      }
      // 未適用がたまっている（通信が一時的に詰まって、まとめて届いた）：このステップで 1 件余分に適用して追いつく
      const f = this.fighter;
      // 未適用が 2 件以上の状態が 0.5 秒続いた時も 1 件追いつく（通信の揺れでたまった分を少しずつ減らし、HOST での反映の遅れを小さく保つ）
      this.standing = q.length > 1 ? (this.standing || 0) + 1 : 0;
      const drain = this.standing >= CFG.hostDrainTicks;
      // Phase 9：試合中だけ（終了後に GUEST の入力でルミポを動かさない。通常の 1 件は既存の Game.step が試合中以外は捨てる）
      if ((q.length > CFG.hostQueueTarget || drain) && f.status && f.status.isAlive && KG.game && KG.game.phase === 'fight') {
        this.standing = 0;
        const extra = q.shift();
        this.noteApplied(extra);
        f.update(KG.CONFIG.fixedStep, this.toCmd(extra), this.stage);   // 既存の物理をそのまま 1 回分
        if (this.onFx) for (const ev of f.fxEvents) this.onFx(ev);       // Phase 6：追いつきのステップで出た演出（溜め・放電）も既存の Effects へ
        if (this.onSpawn) for (const ev of f.spawnEvents) this.onSpawn(ev); // Phase 7：追いつきのステップで発射した泡も既存の ProjectileSystem へ
        f.fxEvents.length = 0; f.spawnEvents.length = 0;
        if (f.action && f.action.aid == null) f.action.aid = aidFor(f);
        this.catchUps++;
      }
      const c = q.shift();
      this.noteApplied(c);
      return this.toCmd(c);
    }
  }

  // ルミポの移動に関わる値（予測の作り直しに必要なものすべて）。HOST はそのまま（丸めずに）送る
  // Phase 4 で技・被弾の値を追加：[12] 技のフレーム（-1 = 技なし）/ [13] 攻撃の先行入力残り / [14] ヒットストップ残り /
  //   [15] 被弾硬直残り / [16] 傾き / [17] 今の技の攻撃 ID / [18] 最後に適用した攻撃押下の番号
  // Phase 8 で追加：[25] ガードの状態 / [26] 出始めからのフレーム（100 まで）/ [27] ガード硬直の残り / [28] ガードの向き
  // Phase 7 で追加：[22] 泡の先行入力残り / [23] バブルショットの再使用待ちのステップ数 / [24] 最後の泡押下の番号
  // Phase 6 で追加：[19] 必殺の先行入力残り / [20] クラゲ電撃の再使用待ちが始まってからのステップ数（-1 = なし）/ [21] 最後の必殺押下の番号
  //   技の種類は [17] 攻撃 ID の下 1 ビットで分かる
  function getLogic(f) {
    const a = f.action;
    return [f.x, f.y, f.vx, f.vy, f.facing < 0 ? -1 : 1, f.grounded ? 1 : 0, f.airJumpsLeft,
      f.coyoteTimer, f.jumpBufferTimer, f.jumpQueuedDuringAction ? 1 : 0, f.canCutJump ? 1 : 0, f.launched ? 1 : 0,
      a ? a.frame : -1, f.attackBufferTimer, f.hitstop, f.hitstun, f.angle, a ? (a.aid || 0) : 0, f.lastPressSeq || 0,
      f.specialBufferTimer, cdSteps(f, JELLY()), f.lastSpecialSeq || 0,
      f.shootBufferTimer, cdSteps(f, BUBBLE()), f.lastShootSeq || 0,
      Math.max(0, GUARD_STATES.indexOf(f.guardState)), Math.min(100, f.guardFrames), f.guardStun, f.guardFacing < 0 ? -1 : 1];
  }
  function setLogic(f, p) {
    f.x = p[0]; f.y = p[1]; f.vx = p[2]; f.vy = p[3]; f.facing = p[4]; f.grounded = !!p[5];
    f.airJumpsLeft = p[6]; f.coyoteTimer = p[7]; f.jumpBufferTimer = p[8];
    f.jumpQueuedDuringAction = !!p[9]; f.canCutJump = !!p[10]; f.launched = !!p[11];
    f.ground = null;
    f.action = p[12] >= 0 ? { move: moveOfKind(kindOfAid(p[17])), frame: p[12], hitVictims: new Set(), aid: p[17] } : null;
    f.attackBufferTimer = p[13]; f.hitstop = p[14]; f.hitstun = p[15]; f.angle = f.prevAngle = p[16];
    f.lastPressSeq = p[18];
    f.specialBufferTimer = p[19]; f.lastSpecialSeq = p[21];
    f.shootBufferTimer = p[22]; f.lastShootSeq = p[24];
    f.guardState = GUARD_STATES[p[25]]; f.guardFrames = p[26]; f.guardStun = p[27]; f.guardFacing = p[28];
    f.cooldowns = {};
    if (p[20] >= 0) { const v = cdValue(JELLY(), p[20]); if (v > 0) f.cooldowns.jellyShock = v; }
    if (p[23] >= 0) { const v = cdValue(BUBBLE(), p[23]); if (v > 0) f.cooldowns.bubbleShot = v; }
  }
  // 予測・作り直しで入力 1 件を適用する（HOST の RemoteInputController と同じ規則で攻撃 ID を付ける）
  function applyCmd(f, c, stage) {
    if (c.pa) f.lastPressSeq = c.s;
    if (c.ps) f.lastSpecialSeq = c.s;
    if (c.pb) f.lastShootSeq = c.s;
    const had = f.action;
    quietly(() => f.update(KG.CONFIG.fixedStep, RemoteInputController.prototype.toCmd(c), stage));
    f.lastSpawns = f.spawnEvents.slice();                  // Phase 7：このステップで出た泡（予測の時だけ使う。作り直しでは使わない）
    f.fxEvents.length = 0; f.spawnEvents.length = 0;      // 演出は表示側で攻撃 ID ごとに 1 回だけ出す
    if (f.action && f.action.aid == null) f.action.aid = aidFor(f);
    return f.action && f.action !== had ? f.action : null;   // このステップで新しく始まった技
  }

  // ---------------- HOST：コタロ（本人の操作）から攻撃系の入力だけを外すフィルター ----------------
  class MoveOnlyController {
    constructor(input) { this.input = input; this.isAI = false; }
    reset() {}
    poll() {
      const cmd = this.input.poll();
      for (const a of BLOCKED_ACTIONS) { cmd.held[a] = false; cmd.pressed[a] = false; }
      this.lastGuard = !!cmd.held.guard;   // Phase 8：診断（空中で押していたか）
      return cmd;
    }
  }
  const idleController = { isAI: false, reset() {}, poll() { return KG.createEmptyCommand(); } };

  class OnlineMoveTest {
    constructor(session, hooks) {
      this.session = session;
      this.hooks = hooks || {};
      this.active = false;
      this.starting = null;
      this.role = null;
      this.testId = 0;
      this.timers = [];
      // Phase 10：ロビーの READY（me = 自分 / peer = 相手。GUEST の peer は HOST から届いた値、meHost = HOST が確認した自分の値）と、試合（match gen）
      this.lobby = { me: false, peer: false, meHost: false };
      this.genCounter = 0;          // HOST：試合の番号（このページで増え続ける。再戦ごとに +1）
      this.mt = null;               // 今の試合：{ gen, state: 'wait' | 'countdown' | 'fight' | 'ending' | 'result', … }
      this.mtStats = { staleMatch: 0, matches: 0 };   // 古い試合の受信を捨てた数・始めた試合の数（診断）
      // Phase 3：GUEST の予測 ON / OFF（A/B 比較用）。URL に ?pred=off で最初から OFF
      const qs = new URLSearchParams(location.search);
      this.predEnabled = qs.get('pred') !== 'off';
      // Phase 5：HOST の遅延補償 ON / OFF（A/B 比較用）。URL に ?lagcomp=off で最初から OFF、?lagmax=150 などで上限を変更（実験用）
      this.lagEnabled = qs.get('lagcomp') !== 'off';
      const lm = Number(qs.get('lagmax'));
      if (qs.has('lagmax') && Number.isFinite(lm)) CFG.lagMaxMs = Math.max(0, Math.min(300, lm));
      this.buildDom();
      // P キー：予測 ON / OFF（GUEST・実験中のみ）
      window.addEventListener('keydown', (e) => {
        if (e.code === 'KeyP' && !e.repeat && this.active && this.role === 'GUEST') { e.preventDefault(); this.setPrediction(!this.predEnabled); }
        if (e.code === 'KeyC' && !e.repeat && this.active && this.role === 'HOST') { e.preventDefault(); this.setLagComp(!this.lagEnabled); }   // Phase 5
      });
      // Phase 6（診断）：GUEST が J / K を押した時刻（押してから予測で技が始まるまでの時間を測る）。入力そのものは既存の InputManager が読む
      window.addEventListener('keydown', (e) => {
        if (e.repeat || !this.active || this.role !== 'GUEST') return;
        if (e.code === 'KeyJ') this.st.keyAt[0] = e.timeStamp || now();
        else if (e.code === 'KeyK') this.st.keyAt[1] = e.timeStamp || now();
        else if (e.code === 'KeyL') this.st.keyAt[2] = e.timeStamp || now();
        else if (e.code === 'KeyI') this.st.keyAt[3] = e.timeStamp || now();   // Phase 8：ガード
      }, true);
      session.on('game', (m) => this.onMsg(m));
      session.on('state', (st) => {
        if (st !== 'connected' && (this.active || this.starting)) this.stop('disconnect');
        if (st !== 'connected') this.lobbyReset();   // Phase 10：切断したら READY も解除（既存の切断処理はそのまま）
      });
      // Phase 10：勝敗表示で Enter = 「もう一度」（既存のメニューへは online-ui が Enter を渡さない）
      window.addEventListener('keydown', (e) => {
        if (e.repeat || !this.active || !KG.game || KG.game.phase !== 'result') return;
        if (e.code === 'Enter' || e.code === 'NumpadEnter') { e.preventDefault(); this.requestRematch(); }
      }, true);
    }

    log(t, lv) { this.session.log('[MOVE] ' + t, lv); }

    // ---------------- 開始・終了 ----------------
    // HOST が「操作実験を開始」を押した：GUEST へ開始を伝え、準備完了の返事を待ってから両方で開始
    requestStart() {
      const s = this.session;
      if (s.role !== 'HOST' || s.state !== 'connected' || this.active || this.starting) return false;
      const rnd = new Uint32Array(1);
      crypto.getRandomValues(rnd);                    // Math.random は使わない（CPU 対戦の乱数に一切影響させない）
      const id = (rnd[0] % 999999) + 1;
      this.starting = { id, t: now() };
      s.sendGame({ t: 'ms', id });
      this.log('start requested (id ' + id + ') → waiting for GUEST');
      const st = this.starting;
      this.timers.push(setTimeout(() => {
        if (this.starting !== st) return;
        this.starting = null;
        s.sendGame({ t: 'me', id, r: 'timeout' });
        this.log('GUEST did not answer the start request', 'warn');
        this.lobbyReset(); this.sendLobby();   // Phase 10：両方 NOT READY に戻す
        if (this.hooks.onStartFailed) this.hooks.onStartFailed('timeout');
      }, CFG.startAckTimeoutMs));
      if (this.hooks.onStarting) this.hooks.onStarting();
      return true;
    }

    // 自分から終了（「操作実験を終了」ボタン）
    end() {
      if (!this.active && !this.starting) return;
      const id = this.active ? this.testId : this.starting.id;
      this.session.sendGame({ t: 'me', id, r: 'user' });
      this.stop('user');
    }

    begin(role, id) {
      const g = KG.game;
      if (!g || this.active) return false;
      this.active = true;
      this.role = role;
      this.testId = id;
      this.resetStats();
      this.saved = {
        pCtl: g.player.controller, cCtl: g.cpu.controller,
        pStocks: g.player.status.initialStocks, cStocks: g.cpu.status.initialStocks,
      };
      // Phase 9：ストックは Version 1.0 と同じ値（3）。場外・リスポーン・無敵は HOST の既存 StockRules がそのまま決める
      g.player.status.initialStocks = KG.CONFIG.rules.stocks;
      g.cpu.status.initialStocks = KG.CONFIG.rules.stocks;
      if (role === 'HOST') {
        // Phase 9：KO（既存の onKnockOut の後）を記録してステップの終わりにまとめて送る。最後のストック（既存の onFighterKO）は
        //   すぐに勝者を決めず、同じステップの KO を集めてから確定する（同時 KO を処理順で決めない）
        this.saved.onKnockOut = Object.prototype.hasOwnProperty.call(g, 'onKnockOut') ? g.onKnockOut : null;   // 効果音（installSound）の包みを残す
        const baseOut = this.saved.onKnockOut || KG.Game.prototype.onKnockOut;
        g.onKnockOut = (e, point) => { baseOut.call(g, e, point); this.onHostKO(e, point); };
        g.onFighterKO = (e) => { this.st.ko.finals.push(e); };
        // 試合終了後の場外：ストック・勝敗は変えず、表示から外すだけ（終了後に状態が変わらないように）
        g.rules.knockOut = (e) => {
          if (this.st.ko.over) { e.status.lifeState = 'respawning'; e.status.respawnTimer = Infinity; e.status.invincibleTimer = 0; return; }
          KG.StockRules.prototype.knockOut.call(g.rules, e);
        };
        this.remote = new RemoteInputController(g.cpu, g.stage);
        this.remote.onPress = (c) => this.computeRewind(c);
        this.remote.onFx = (ev) => g.effects.spawnMoveFx(ev);
        this.remote.onSpawn = (ev) => g.projectiles.spawnFrom(ev.owner, ev.spawn);
        this.remote.onGuard = (c) => { const off = this.session.clockOffset; if (off != null) this.st.guardApply.add(Math.max(0, now() - (c.ts - off))); };   // Phase 8
        g.cpu.controller = this.remote;                       // ルミポ：CPU AI を止め、GUEST の入力で動かす
        g.player.controller = new MoveOnlyController(g.input); // コタロ：本人の操作（泡・ガードは無効）
      } else {
        this.remote = null;
        g.player.controller = idleController;                 // GUEST は自分でゲームを進めない
        g.cpu.controller = idleController;
      }
      // Phase 4 / 6 / 7：両者の通常攻撃をぽよんアタック、必殺をクラゲ電撃、泡をバブルショットに揃える（このインスタンスだけ。終了時に削除して元に戻す）
      g.player.selectMove = onlineSelectMove;
      g.cpu.selectMove = onlineSelectMove;
      if (role === 'HOST') {
        // 命中の記録：既存の receiveHit を呼んだ後に、命中イベントを GUEST へ送る（ダメージ・吹っ飛びは既存処理のまま）
        for (const victim of [g.player, g.cpu]) {
          const orig = KG.Fighter.prototype.receiveHit;
          victim.receiveHit = (hit) => { const pre = this.guardPre(victim); orig.call(victim, hit); this.onHostHit(victim, hit, pre); };
          // Phase 8：ガード成立（既存の Combat → receiveGuard の後）。ガードの結果を GUEST へ 1 回だけ送る（押し戻し・硬直は既存処理のまま）
          const origG = KG.Fighter.prototype.receiveGuard;
          victim.receiveGuard = (gd) => { origG.call(victim, gd); this.onHostGuard(victim, gd); };
        }
        // Phase 5 / 6：コタロの Hurtbox（このインスタンスだけ）。ルミポの近接攻撃（ぽよん・クラゲ電撃）の判定が出ている間だけ、遅延補償の過去位置で作る
        const self = this;
        g.player.getHurtboxes = function () { return self.lagHurtboxes() || KG.Fighter.prototype.getHurtboxes.call(this); };
        // Phase 5：診断表示中だけ、今と過去の Hurtbox を重ねて描く
        g.render = (alpha) => { KG.Game.prototype.render.call(g, alpha); this.drawLagViz(alpha); };
        // Phase 7：泡（ProjectileSystem のこのインスタンスだけ）。発射は既存の spawnFrom のまま、オンライン用の ID を付けて記録。
        //   消える時（既存の removeDead）に消滅イベントを 1 回送る。
        const PS = KG.ProjectileSystem.prototype;
        g.projectiles.spawnFrom = (owner, spawn) => { const pr = PS.spawnFrom.call(g.projectiles, owner, spawn); this.onHostSpawn(owner, pr); return pr; };
        g.projectiles.removeDead = () => { this.onHostRemoveDead(); return PS.removeDead.call(g.projectiles); };
        // Combat.resolve の中で「今の攻撃側が泡か」を知るため（泡には遅延補償を使わない）。キャラの攻撃判定の取り出しで解除
        for (const f of [g.player, g.cpu]) f.getActiveHitboxes = function () { self.projAttacking = false; return KG.Fighter.prototype.getActiveHitboxes.call(this); };
      }
      this.lobbyReset();                                    // Phase 10：ロビーの READY は使い終わり（次に戻った時は両方 NOT READY から）
      this.mt = { gen: 0, state: 'wait', goLocal: null, rematch: [false, false], myRematch: false, lastMlAt: 0, phaseSent: null };
      if (role === 'GUEST') {
        // Phase 10：HOST が試合（match gen）を始めるまでは待つだけ（カウントダウンの表示も HOST の合図から）
        g.countdownLabel = () => (this.mt.state === 'wait' ? null : KG.Game.prototype.countdownLabel.call(g));
        this.resetGuestMatch(0);
      }
      this.clearInput();
      const step0 = KG.Game.prototype.step;
      g.step = role === 'HOST'
        ? (dt) => { step0.call(g, dt); this.afterHostStep(dt); }
        : (dt) => this.guestStep(dt);
      document.body.dataset.onlineTest = role.toLowerCase();
      this.hud.hidden = false;
      this.$.role.textContent = role === 'HOST' ? 'HOST：コタロを操作中（ルミポ = GUEST）' : 'GUEST：ルミポを操作中';
      this.hud.dataset.role = role.toLowerCase();
      this.renderPredBtn();
      this.diagTimer = setInterval(() => this.renderDiag(), 250);
      this.renderDiag();
      this.log('move test started as ' + role + ' (id ' + id + ')');
      if (role === 'HOST') this.startOnlineMatch();          // Phase 10：最初の試合（カウントダウンから）
      if (this.hooks.onStart) this.hooks.onStart(role);
      return true;
    }

    // 終了・切断：ゲームを止め、差し替えたものをすべて元に戻してタイトル状態へ
    stop(reason) {
      if (!this.active && !this.starting) return;
      const wasActive = this.active;
      this.starting = null;
      this.active = false;
      for (const t of this.timers) clearTimeout(t);
      this.timers = [];
      clearInterval(this.diagTimer);
      const g = KG.game;
      if (wasActive && g) {
        if (this.remote) this.remote.setNeutral();        // 入力をニュートラルへ
        delete g.step;                                    // 元の Game.prototype.step に戻す
        for (const f of [g.player, g.cpu]) { delete f.selectMove; delete f.receiveHit; delete f.receiveGuard; delete f.lastPressSeq; delete f.lastSpecialSeq; delete f.lastShootSeq; delete f.getHurtboxes; delete f.getActiveHitboxes; }  // 差し替えを削除
        delete g.render;
        delete g.projectiles.spawnFrom; delete g.projectiles.removeDead;   // Phase 7
        if (this.role === 'HOST') {   // Phase 9：KO の差し替えを元に戻す（効果音の包みはそのまま残す）
          if (this.saved.onKnockOut) g.onKnockOut = this.saved.onKnockOut; else delete g.onKnockOut;
          delete g.onFighterKO; delete g.rules.knockOut;
        }
        delete g.countdownLabel;                          // Phase 10（GUEST）
        g.projectiles.clear();
        g.player.controller = this.saved.pCtl;
        g.cpu.controller = this.saved.cCtl;               // CPU AI を元のまま戻す
        g.player.status.initialStocks = this.saved.pStocks;
        g.cpu.status.initialStocks = this.saved.cStocks;
        g.goToTitle();                                    // 位置・ストック・AI などをすべて初期化
        this.padReset();
        this.clearInput();
        delete document.body.dataset.onlineTest;
        this.hud.hidden = true;
        this.log('move test stopped (' + reason + ')');
      }
      this.remote = null;
      this.pred = null;                                   // 予測も止める（切断後にルミポを動かし続けない）
      if (this.mt) this.mt.state = 'stopped';
      this.lobbyReset();                                  // Phase 10：接続画面に戻ったら両方 NOT READY（もう一度 READY を押して次の試合）
      if (this.hooks.onStop) this.hooks.onStop(reason, wasActive);
    }

    clearInput() {
      const g = KG.game;
      try { g.keyboard.reset(); g.input.releaseAll(); g.input.poll(); } catch (_) { /* noop */ }
      if (this.hooks.clearTouch) this.hooks.clearTouch();
    }

    resetStats() {
      this.st = {
        stepCount: 0, stateSeq: 0, inputSeq: 0, jp: 0,
        cur: { l: 0, r: 0, j: 0, jp: 0 }, lastInputSentAt: 0, sentTimes: new Map(),
        inputRate: new RateMeter(), stateRate: new RateMeter(), inRateWindow: 0, inRateCount: 0,
        staleInputs: 0, badInputs: 0, floodDropped: 0, neutralCount: 0, staleStates: 0,
        lastInputSeqRecv: 0, lastStateSeqRecv: 0, lastStateAt: 0, lastAcked: 0,
        inputDelay: new Stat(), stateDelay: new Stat(), reflect: new Stat(),
        snaps: [], tOff: null, extrapolating: false, extrapCount: 0, waitingFirstState: true,
        // Phase 3：予測
        pending: [], predErr: new Stat(), lastErrX: 0, lastErrY: 0, corrections: 0, snapCount: 0, reconciles: 0, nonZeroErr: 0,
        vis: { x: 0, y: 0 }, blend: false, predHidden: false, hostAlive: true, lastInv: 0, pendingDropped: 0, wasStalled: false, stallCount: 0,
        // Phase 4：攻撃（HOST）
        atk: [{ action: null }, { action: null }], kotaroAid: 0, hitSeq: 0,
        accepted: [0, 0], rejected: 0, hits: [0, 0], misses: [0, 0], startDelay: new Stat(), lastAcceptedAid: 0, lastPressRecv: 0,
        // Phase 4：攻撃（GUEST）
        ap: 0, lastPressSent: 0, predAttacks: new Map(), acceptedAids: new Set(), lastHostAid: 0, hitRecvIds: new Set(), hitRecv: 0, lastHitId: 0,
        acceptRtt: new Stat(), hitShowDelay: new Stat(), matrix: { vv: 0, vm: 0, mv: 0, mm: 0 }, hostRejectedPred: 0, hostOnly: 0,
        dKotaro: new Samples(), dRuimpo: new Samples(), hitCorr: 0, hitErr: new Stat(), hitSnaps: 0, hitPending: false,
        ghost: null, flash: [0, 0], latestF: null,
        // Phase 5：遅延補償（HOST）
        hist: [], sentTicks: new Map(), kotaroHits: 0, lagBlocked: 0, rewindMs: new Samples(), capHits: 0, invalidRewind: 0, noRef: 0,
        lagCls: { both: 0, pastOnly: 0, curOnly: 0, none: 0 }, posDiff: new Samples(), escGap: new Samples(), lagOnlyHits: 0, lagViz: null, escCls: [0, 0, 0],
        // Phase 5：遅延補償（GUEST）
        viewRef: null, matrixCur: { vv: 0, vm: 0, mv: 0, mm: 0 }, gRewind: new Samples(), dKotaroPast: new Samples(),
        // Phase 6：技の種類ごと（[0] ぽよん / [1] クラゲ電撃）の集計。上の Phase 4 / 5 の値は両方の合計のまま
        sp: 0, lastSpecialSent: 0, keyAt: [0, 0, 0, 0],
        hk: [0, 1, 2].map(() => ({
          pressRecv: 0, accepted: 0, rejected: 0, hits: 0, misses: 0, startDelay: new Stat(),              // ルミポ（GUEST）
          kAccepted: 0, kHits: 0, kMisses: 0,                                                              // コタロ（HOST）
          rewindMs: new Samples(), lagCls: { both: 0, pastOnly: 0, curOnly: 0, none: 0 }, posDiff: new Samples(),
          escGap: new Samples(), escCls: [0, 0, 0], lagOnlyHits: 0, lagBlocked: 0,
        })),
        gk: [0, 1, 2].map(() => ({
          pressSent: 0, predStarted: 0, accepted: 0, hostRejectedPred: 0, hits: 0, misses: 0,
          matrix: { vv: 0, vm: 0, mv: 0, mm: 0 }, matrixCur: { vv: 0, vm: 0, mv: 0, mm: 0 },
          dKotaro: new Samples(), dKotaroPast: new Samples(), gRewind: new Samples(),
          keyToPred: new Samples(), acceptRtt: new Stat(), hitShow: new Stat(), hitRecv: 0,
        })),
        disp: [null, null],
        // Phase 7：泡（HOST）[0] コタロ / [1] ルミポ。dead = 消えた理由ごと [命中, 地形, 寿命, 場外, その他]
        projSeq: 0, projTotal: 0, projAttacking: false,
        bub: [0, 1].map(() => ({ spawned: 0, spawnFail: 0, hits: 0, dead: [0, 0, 0, 0, 0] })),
        // Phase 8：ガード（HOST）。[0] コタロが受けた / [1] ルミポが受けた。back = ガード中に背面から / startup = 出始め 3F / air = 空中で押していた
        gd: [0, 1].map(() => ({ guard: 0, hit: 0, back: 0, startup: 0, air: 0 })), guardApply: new Stat(),
        // Phase 8：ガード（GUEST）
        gg: { guardRecv: 0, hitRecv: 0, guardMine: 0, hitMine: 0, mismatch: 0, dup: 0, double: 0, keyToGuard: new Samples(), keyToHost: new Samples(), hostGuard: 0, results: new Map() },
        // Phase 7：泡（GUEST）。bubbles = 表示中の泡（キー = 'p' + Projectile ID / 予測泡は 'a' + 攻撃 ID）
        bp: 0, lastShootSent: 0, bubbles: new Map(), deadPids: new Set(), latestB: null, renderH: null,
        gb: { predSpawned: 0, linked: 0, discarded: 0, hostOnly: 0, hits: 0, dead: [0, 0, 0, 0, 0], linkErr: new Samples(), resid: new Samples() },
        // Phase 9：KO・ストック・勝敗（newKO を参照。Phase 10 で試合ごとに作り直す）
        ko: newKO(0),
      };
    }

    // ---------------- 受信 ----------------
    onMsg(m) {
      switch (m.t) {
        case 'ms':   // GUEST：HOST から開始の合図
          if (this.session.role !== 'GUEST') return;
          if (this.active) { if (m.id === this.testId) this.session.sendGame({ t: 'mr', id: m.id }); return; }
          if (this.begin('GUEST', m.id)) this.session.sendGame({ t: 'mr', id: m.id });
          return;
        case 'mr':   // HOST：GUEST の準備完了 → 開始
          if (this.session.role !== 'HOST' || !this.starting || m.id !== this.starting.id) return;
          this.starting = null;
          this.begin('HOST', m.id);
          return;
        case 'me':
          if ((this.active && m.id === this.testId) || (this.starting && m.id === this.starting.id)) this.stop('remote-' + m.r);
          return;
        case 'mi': return this.onInput(m);
        case 'st': return this.onState(m);
        case 'mh': return this.onHitEvent(m);
        case 'ma': return this.onAttackResult(m);
        case 'pe': return this.onProjEvent(m);
        case 'mk': return this.onKOEvent(m);   // Phase 9
        case 'ml': return this.onLifecycle(m); // Phase 10
        case 'rd': return this.onReady(m);     // Phase 10
      }
    }

    // ---------------- HOST ----------------
    onInput(m) {
      if (!this.active || this.role !== 'HOST') { this.session.stats.dropped++; return; }
      const st = this.st;
      const t = now();
      // 異常な高頻度：1 秒あたり maxInputsPerSec を超えた分は無視（ゲーム処理は 1 ステップ 1 回の poll なので壊れない）
      if (t - st.inRateWindow > 1000) { st.inRateWindow = t; st.inRateCount = 0; }
      if (++st.inRateCount > CFG.maxInputsPerSec) { st.floodDropped++; return; }
      const prevAp = this.remote.lastAp, prevSp = this.remote.lastSp, prevBp = this.remote.lastBp;
      const res = this.remote.accept(m, t, m.m !== this.mt.gen || this.mt.state !== 'fight');   // Phase 10：今の試合の対戦中以外の入力は何も押していない扱い
      if (res === 'stale') { st.staleInputs++; return; }
      if (res === 'bad') { st.badInputs++; return; }
      st.inputRate.hit();
      st.lastInputSeqRecv = m.s;
      if (m.m !== this.mt.gen) this.mtStats.staleMatch++;
      if (m.ap > prevAp) { st.lastPressRecv = m.s; st.hk[0].pressRecv++; }   // GUEST が攻撃を押した入力の番号（受信）
      if (m.sp > prevSp) { st.lastPressRecv = m.s; st.hk[1].pressRecv++; }   // Phase 6：必殺
      if (m.bp > prevBp) st.hk[2].pressRecv++;                                // Phase 7：泡
      // Phase 9：試合終了後に届いた押下（終了を知る前に GUEST が押したもの）。既存の Game.step が試合中以外の入力を捨てるので状態は変わらない
      if (st.ko.over && (m.ap > prevAp || m.sp > prevSp || m.bp > prevBp)) st.ko.lateInputs++;
      // GUEST の送信時刻を自分の時計に直して、届くまでの時間を推定（Ping から推定した時計のずれを使う）
      const off = this.session.clockOffset;
      if (off != null) st.inputDelay.add(Math.max(0, t - (m.ts - off)));
    }

    afterHostStep() {
      const st = this.st;
      if (!this.active) return;
      st.stepCount++;
      const r = this.remote;
      if (!r.neutral && now() - r.lastAt > CFG.inputTimeoutMs) {
        r.setNeutral();
        st.neutralCount++;
        this.log('GUEST input timed out (' + CFG.inputTimeoutMs + 'ms) → neutral', 'warn');
      }
      r.tick = st.stepCount;
      // Phase 5：コタロの Hurtbox を作るのに必要な値だけを残す（短いリングバッファ）
      const k = KG.game.player;
      st.hist.push({ tick: st.stepCount, x: k.x, y: k.y, facing: k.facing, alive: k.status.isAlive, hits: st.kotaroHits });
      if (st.hist.length > CFG.histTicks) st.hist.shift();
      this.trackHostAttacks();
      this.flushHostKOs();
      this.trackHostLifecycle();
      if (st.stepCount % CFG.stateEverySteps === 0) this.sendState();
    }

    // ---------------- Phase 10：ロビー（READY）と試合の流れ ----------------
    // 接続画面の READY：両方 NOT READY に戻す（試合の開始時・接続画面へ戻った時・切断時）
    lobbyReset() {
      this.lobby.me = false; this.lobby.peer = false; this.lobby.meHost = false;
      if (this.hooks.onLobby) this.hooks.onLobby();
    }
    // 自分の READY を切り替える（接続中で、試合をしていない時だけ）。HOST が両方の READY を確かめて試合を始める
    setReady(on) {
      const s = this.session;
      if (s.state !== 'connected' || this.active || this.starting) return false;
      this.lobby.me = !!on;
      if (s.role === 'HOST') { this.sendLobby(); this.tryStartFromLobby(); }
      else s.sendGame({ t: 'rd', m: 0, r: on ? 1 : 0 });   // 状態として送る（同じ値が何度届いても同じ結果）
      if (this.hooks.onLobby) this.hooks.onLobby();
      return true;
    }
    // HOST：ロビーの READY の状態（HOST が確認した両方の値）を GUEST へ
    sendLobby() {
      if (this.session.role !== 'HOST' || this.active) return;
      this.session.sendGame({ t: 'ml', m: 0, s: 0, w: r1(now()), r: 0, hr: this.lobby.me ? 1 : 0, gr: this.lobby.peer ? 1 : 0 });
    }
    tryStartFromLobby() {
      if (this.lobby.me && this.lobby.peer && !this.active && !this.starting) this.requestStart();
    }
    // HOST：GUEST の READY / 再戦希望（m = どの試合の後か。0 = ロビー）
    onReady(m) {
      if (this.session.role !== 'HOST') { this.session.stats.dropped++; return; }
      if (!this.active) {
        if (m.m !== 0) { this.mtStats.staleMatch++; return; }   // 終わった試合の再戦希望が遅れて届いた：ロビーの READY にはしない
        this.lobby.peer = !!m.r;
        this.sendLobby();
        if (this.hooks.onLobby) this.hooks.onLobby();
        this.tryStartFromLobby();
        return;
      }
      if (m.m !== this.mt.gen || KG.game.phase !== 'result') { if (m.m !== this.mt.gen) this.mtStats.staleMatch++; return; }   // 今の試合の勝敗表示中だけ
      this.mt.rematch[1] = !!m.r;
      this.sendLifecycle();
      this.tryRematch();
    }
    // 勝敗表示の「もう一度」（HOST・GUEST 共通）。HOST が両方の希望を確かめて次の試合を始める
    requestRematch() {
      if (!this.active || !this.mt || KG.game.phase !== 'result') return false;
      if (this.role === 'HOST') {
        this.mt.rematch[0] = true;
        this.sendLifecycle();
        this.tryRematch();
      } else {
        this.mt.myRematch = true;
        this.session.sendGame({ t: 'rd', m: this.mt.gen, r: 1 });
      }
      try { if (KG.sound) KG.sound.play('confirm'); } catch (_) { /* noop */ }
      this.renderResultUi();
      return true;
    }
    tryRematch() {
      if (this.mt.rematch[0] && this.mt.rematch[1]) this.startOnlineMatch();
    }
    // HOST：新しい試合を始める（新しい match gen → 初期化 → カウントダウン）。同じ接続のまま
    startOnlineMatch() {
      const g = KG.game, st = this.st;
      const gen = ++this.genCounter;
      this.mt = { gen, state: 'countdown', goLocal: null, rematch: [false, false], myRematch: false, lastMlAt: 0, phaseSent: null };
      this.mtStats.matches++;
      // ゲームの状態は既存の startMatch（resetTest）：出現位置・速度・ダメージ・ストック・KO・復帰待ち・無敵・技・被弾硬直・ガード・
      //   再使用待ち・先行入力・泡・演出・勝敗 → 'countdown'（3 → 2 → 1 → START! と、その間は入力を捨てるのも既存の Game.step）
      g.startMatch();
      // ネットワーク側の試合ごとの状態：未適用の入力・押しっぱなし・技の記録・遅延補償の履歴・KO の記録（番号は増え続ける）
      this.remote.resetMatch();
      st.atk = [{ action: null }, { action: null }];
      st.hist = []; st.lagViz = null; st.projAttacking = false;
      st.ko = newKO(st.ko.seq);
      this.clearInput();
      this.sendLifecycle();
      this.renderResultUi();
      this.log('MATCH #' + gen + ' → countdown');
    }
    // HOST：毎ステップの終わり。段階が変わった時（カウントダウン → 対戦 → 決着 → 勝敗表示）と、0.5 秒ごとに試合の状態を送る
    trackHostLifecycle() {
      const g = KG.game, mt = this.mt;
      if (MT_CODE[g.phase]) mt.state = g.phase;
      if (mt.phaseSent !== g.phase || now() - mt.lastMlAt > 500) this.sendLifecycle();
    }
    // 試合の状態 ml：m = 試合の番号 / s = 段階 / cd = GO までの残り（ms。カウントダウン中だけ）/ w = HOST の時刻 / r = 結果 / hr・gr = 再戦希望
    sendLifecycle() {
      const g = KG.game, mt = this.mt, code = MT_CODE[g.phase] || 0;
      const msg = { t: 'ml', m: mt.gen, s: code, w: r1(now()), r: this.st.ko.result, hr: mt.rematch[0] ? 1 : 0, gr: mt.rematch[1] ? 1 : 0 };
      if (code === 1) msg.cd = Math.max(0, Math.round((KG.CONFIG.match.countdownStep * 3 - g.phaseTime) * 1000));
      this.session.sendGame(msg);
      mt.phaseSent = g.phase; mt.lastMlAt = now();
    }

    // GUEST：HOST の試合の状態（段階の移り変わりは HOST の合図だけで行う。自分では始めない・決めない）
    onLifecycle(m) {
      if (this.session.role !== 'GUEST') { this.session.stats.dropped++; return; }
      if (m.s === 0) {   // ロビー（接続画面）の READY
        if (!this.active && !this.starting) { this.lobby.peer = !!m.hr; this.lobby.meHost = !!m.gr; if (this.hooks.onLobby) this.hooks.onLobby(); }
        return;
      }
      if (!this.active) { this.session.stats.dropped++; return; }
      const g = KG.game;
      let mt = this.mt;
      if (m.m < mt.gen) { this.mtStats.staleMatch++; return; }   // 前の試合の合図
      if (m.m > mt.gen) { this.resetGuestMatch(m.m); mt = this.mt; }   // 新しい試合：前の試合の状態をすべて捨てる
      mt.rematch = [!!m.hr, !!m.gr];
      if (m.s === 1) {
        // GO の時刻：HOST の時刻 w + 残り cd を、Ping で推定した時計のずれで自分の時計に直す（届くまでの遅れの分ずれない）
        if (mt.state === 'countdown') mt.goLocal = this.hostToLocal(m.w) + m.cd;
      } else if (m.s === 2) {
        this.enterGuestFight(m.w);
      } else {
        if (!this.st.ko.over && m.r) this.finishGuestMatch(m.r);
        if (m.s === 4 && mt.state !== 'result') {
          mt.state = 'result'; g.phase = 'result'; g.phaseTime = 0;
          this.onGuestResultShown();
        }
      }
      this.renderResultUi();
    }
    // HOST の時刻（performance.now）→ 自分の時刻。Ping の時計のずれ（相手 − 自分）が無い間は、受信時刻 − 片道（RTT / 2）
    hostToLocal(w) {
      const off = this.session.clockOffset;
      if (off != null) return w - off;
      const rtt = this.session.ping.last;
      return now() - (rtt != null ? rtt / 2 : 0);
    }
    // GUEST：HOST が対戦開始（GO）を確定した → ここから操作・予測を始める
    enterGuestFight(w) {
      const g = KG.game, mt = this.mt;
      if (mt.state !== 'countdown' && mt.state !== 'wait') return;
      if (mt.goLocal == null) mt.goLocal = this.hostToLocal(w);
      mt.state = 'fight';
      g.phase = 'fight';
      g.phaseTime = Math.min(KG.CONFIG.match.startShow, Math.max(0, (now() - mt.goLocal) / 1000));   // START! の表示は GO の時刻から
      this.log('MATCH #' + mt.gen + ' → fight');
    }
    guestFighting() { return !!this.mt && this.mt.state === 'fight' && !this.st.ko.over; }
    // GUEST：段階ごとの表示時間。カウントダウンは GO の推定時刻から逆算（3 / 2 / 1 を HOST とそろえる。START! は HOST の確定まで出さない）
    updateGuestPhase(dt) {
      const g = KG.game, mt = this.mt;
      if (mt.state === 'countdown') {
        const total = KG.CONFIG.match.countdownStep * 3;
        g.phase = 'countdown';
        g.phaseTime = mt.goLocal == null ? 0 : Math.min(total - 0.001, Math.max(0, total - (mt.goLocal - now()) / 1000));
      } else g.phaseTime += dt;
    }
    // GUEST：新しい試合（gen = 0 は最初の試合の合図を待つ間）。ゲームは既存の startMatch で初期化し、ネットワーク側の試合ごとの状態をすべて捨てる
    resetGuestMatch(gen) {
      const g = KG.game, st = this.st;
      this.mt = { gen, state: gen ? 'countdown' : 'wait', goLocal: null, rematch: [false, false], myRematch: false, lastMlAt: 0, phaseSent: null };
      if (gen) this.mtStats.matches++;
      g.startMatch();   // 出現位置・ダメージ・ストック・勝敗・泡の表示・演出 → 'countdown'
      Object.assign(st, {
        // 予測と補正：未確認入力・表示のずれ・被弾補正・見た目だけの技
        pending: [], vis: { x: 0, y: 0 }, blend: false, predHidden: false, hostAlive: true, lastInv: 0, hitPending: false, ghost: null,
        fastUntil: 0, respawnSnap: false, wasStalled: false,
        // 補間の履歴（前の試合の状態から補間しない）
        snaps: [], latestF: null, interpCpu: null, viewRef: null, renderH: null, extrapolating: false,
        // 技の表示・命中・泡（予測泡・消えた泡の記録）・KO
        predAttacks: new Map(), disp: [null, null], flash: [0, 0],
        bubbles: new Map(), deadPids: new Set(), hitRecvIds: new Set(), lastHitId: 0, ko: newKO(0),
      });
      // 予測用のルミポ（画面には出さない「計算用」）を作り直す。同じ Fighter クラス・同じキャラ定義（移動値）・同じステージで動かす
      this.pred = new KG.Fighter(g.cpu.def, { id: 'prediction', status: new KG.CombatStatus({ stocks: Infinity }) });
      this.pred.selectMove = onlineSelectMove;
      // Phase 7：予測でも「自分の泡は同時 2 個まで」（既存の projectileGate と同じ形。数えるのは GUEST の画面の自分の泡）
      this.pred.projectileGate = (owner, defId) => this.ownBubbleCount() < KG.PROJECTILES[defId].maxPerOwner;
      setLogic(this.pred, getLogic(g.cpu));               // 開始位置は HOST と同じ（startMatch で同じ出現位置）
      this.pred.state = g.cpu.state;
      this.clearInput();
      this.renderResultUi();
      if (gen) this.log('MATCH #' + gen + ' → countdown');
    }
    // 勝敗表示の「もう一度」「終了する」と再戦の状態（オンラインの時だけ表示。既存の「もう一度」「タイトルへ戻る」は CSS で隠す）
    renderResultUi() {
      const el = this.$ && this.$.res;
      if (!el || !this.mt) return;
      const host = this.role === 'HOST';
      const me = this.mt.rematch[host ? 0 : 1] || (!host && this.mt.myRematch);
      const peer = this.mt.rematch[host ? 1 : 0];
      const txt = me ? '相手を待っています…' : peer ? '相手が再戦を希望しています' : '';
      if (el.status.textContent !== txt) el.status.textContent = txt;
      el.again.disabled = me;
      const label = me ? '再戦を希望しました' : 'もう一度';
      if (el.again.textContent !== label) el.again.textContent = label;
    }
    // 診断：試合の番号・段階・再戦希望・古い試合の受信を捨てた数
    matchLine() {
      const mt = this.mt;
      if (!mt) return '';
      return 'MATCH #' + mt.gen + ' ' + mt.state + '  再戦 HOST ' + (mt.rematch[0] ? '○' : '-') + ' GUEST ' + (mt.rematch[1] || mt.myRematch ? '○' : '-') +
        '  試合数 ' + this.mtStats.matches + '  古い試合の受信 ' + this.mtStats.staleMatch;
    }

    // ---------------- Phase 9：KO・勝敗（HOST） ----------------
    // 既存の StockRules が場外を確定した（onKnockOut の後。ストックはもう減っている）。このステップの終わりにまとめて送る
    onHostKO(e, point) {
      if (!this.active || this.role !== 'HOST') return;
      const g = KG.game, K = this.st.ko;
      const v = e === g.player ? 0 : e === g.cpu ? 1 : -1;
      if (v < 0) return;
      K.count[v]++; K.stocks[v] = e.status.stocks;
      K.stepKOs.push({ id: ++K.seq, v, s: e.status.stocks, n: K.count[v], x: r1(point.x), y: r1(point.y) });
      this.log('KO #' + K.seq + ' ' + (v === 0 ? 'コタロ' : 'ルミポ') + ' → stock ' + e.status.stocks);
    }
    // ステップの終わり：このステップで最後のストックを失った側から結果を決め（両方なら引き分け）、KO イベントを送る
    flushHostKOs() {
      const K = this.st.ko, g = KG.game;
      if (K.finals.length && !K.over) this.finishHostMatch(resultFor(K.finals, g));
      K.finals.length = 0;
      for (const k of K.stepKOs) this.session.sendGame({ t: 'mk', id: k.id, v: k.v, s: k.s, n: k.n, x: k.x, y: k.y, r: K.result, m: this.mt.gen });
      K.stepKOs.length = 0;
    }
    // 試合終了を確定（Version 1.0 の onFighterKO と同じ 'ending' → 'result' の流れ。勝者は HOST だけが決める）
    finishHostMatch(code) {
      const g = KG.game, K = this.st.ko;
      K.over = true; K.result = code; K.endAt = now();
      this.applyResult(code);
      // 残っている泡：消滅イベント（理由 = その他）を 1 回ずつ送ってから消す（Version 1.0 も終了時に飛び道具を残さない）
      for (const pr of g.projectiles.list) if (!pr.dead) pr.kill('match');
      this.onHostRemoveDead();
      KG.ProjectileSystem.prototype.clear.call(g.projectiles);
      this.log('MATCH END: ' + g.result + '（stock コタロ ' + g.player.status.stocks + ' / ルミポ ' + g.cpu.status.stocks + '）');
    }
    // 結果の表示（HOST・GUEST 共通）：既存の result / winner / phase をそのまま使う（勝敗表示・BGM は既存の HUD・サウンドが行う）
    applyResult(code) {
      const g = KG.game;
      g.winner = code === 1 ? g.player : code === 2 ? g.cpu : null;
      g.result = g.winner ? g.winner.displayName + ' WIN' : 'DRAW';
      g.phase = 'ending';
      g.phaseTime = 0;
    }

    // HOST：両者の技の開始・終了を見て、攻撃 ID・受理 / 出せなかった・HIT / MISS を記録する（判定そのものは既存処理）
    trackHostAttacks() {
      const g = KG.game, st = this.st, r = this.remote;
      [g.player, g.cpu].forEach((f, idx) => {
        const tr = st.atk[idx];
        const a = f.action;
        if (tr.action && tr.action !== a) this.finishHostAttack(idx, tr);
        if (a && a !== tr.action) {
          const kind = kindOfMove(a.move);
          const K = st.hk[kind];
          if (idx === 1) {
            if (a.aid == null) a.aid = aidFor(f);
            // 受理：この技の元になった押下（同じ種類・同じ番号）。それより前の同じ種類の押下は（硬直中・再使用待ちなどで）出せなかった
            const seq = (a.aid - kind) / 4;
            let started = null;
            r.presses = r.presses.filter((pr) => {
              if (pr.kind !== kind || pr.s > seq) return true;
              if (pr.s === seq) started = pr; else { st.rejected++; K.rejected++; }
              return false;
            });
            const off = this.session.clockOffset;
            if (started && off != null) { const d = Math.max(0, now() - (started.ts - off)); st.startDelay.add(d); K.startDelay.add(d); }
            st.lastAcceptedAid = a.aid;
            a.lag = started && started.lag ? started.lag : { ticks: 0, ms: 0, status: 'none' };   // Phase 5：この技の巻き戻し量（技の種類によらず同じ規則）
            K.accepted++;
          } else {
            a.aid = aidOf(++st.kotaroAid, kind);
            K.kAccepted++;
          }
          st.accepted[idx]++;
          Object.assign(tr, { action: a, aid: a.aid, kind, spawned: false, guarded: false, hit: false, measured: false, kx: 0, rx: 0, curHit: false, pastHit: false, blocked: false, pk: 0, hitsAtStart: st.kotaroHits, lagMs: a.lag ? a.lag.ms : 0 });
        }
        // Phase 5（GUEST の攻撃だけ）：判定が出ている各フレームで「今の位置なら当たるか」「遅延補償の位置なら当たるか」を両方記録（診断用）
        if (idx === 1 && a && tr.action === a && !tr.hit && !tr.guarded) {   // 命中した後のフレームは数えない（命中の瞬間は onHostHit で記録）
          const hbs = f.getActiveHitboxes();
          if (hbs.length && g.player.status.canBeHit) {
            const cur = KG.Fighter.prototype.getHurtboxes.call(g.player);
            const past = a.lag && a.lag.ticks > 0 ? this.pastHurtboxes(st.stepCount - a.lag.ticks, tr.hitsAtStart) : null;
            if (overlapAny(hbs, cur)) tr.curHit = true;
            if (overlapAny(hbs, past || cur)) tr.pastHit = true;
            if (past) st.lagViz = { cur, past, hbs, until: now() + 700 };
            else if (a.lag && a.lag.ticks > 0) tr.blocked = true;
          }
        }
        // 判定が出る最初のフレームの位置（GUEST の見た目との比較用）
        if (a && tr.action === a && !tr.measured && kindOfMove(a.move) !== 2 && a.frame >= firstActive(a.move)) {
          tr.measured = true; tr.kx = g.player.x; tr.rx = g.cpu.x; tr.kAlive = g.player.status.isAlive;
          tr.pk = tr.kx;
          if (idx === 1 && a.lag && a.lag.ticks > 0 && this.pastHurtboxes(st.stepCount - a.lag.ticks, tr.hitsAtStart)) {
            const p = this.kotaroAt(st.stepCount - a.lag.ticks);
            if (p) { tr.pk = p.x; st.posDiff.add(Math.abs(p.x - tr.kx)); st.hk[tr.kind].posDiff.add(Math.abs(p.x - tr.kx)); }   // 今の位置と参照した過去の位置の差
          }
        }
      });
      // 押してから先行入力の時間を過ぎても攻撃が始まらなかった押下 = 出せなかった（攻撃硬直中・被弾中など）
      if (r.presses.length && st.stepCount - r.presses[0].tick > CFG.attackRejectTicks) {
        r.presses = r.presses.filter((pr) => {
          if (st.stepCount - pr.tick <= CFG.attackRejectTicks) return true;
          st.rejected++; st.hk[pr.kind].rejected++;
          return false;
        });
      }
    }

    finishHostAttack(idx, tr) {
      const st = this.st;
      const K = st.hk[tr.kind || 0];
      if (tr.kind === 2) {   // バブルショット：技そのものは当たらない（泡の結果は泡ごとに数える）。発射できなかった技は「拒否」
        if (!tr.spawned) { const B = st.bub[idx]; B.spawnFail++; if (idx === 1) K.rejected++; }
        tr.action = null;
        return;
      }
      if (tr.hit) st.hits[idx]++; else st.misses[idx]++;
      if (idx === 1) { if (tr.hit) K.hits++; else K.misses++; } else if (tr.hit) K.kHits++; else K.kMisses++;
      if (idx === 1) {   // GUEST の攻撃の結果（診断用。GUEST の見た目との比較に使う）
        const c = tr.curHit, pst = tr.pastHit;
        const cls = c && pst ? 'both' : pst ? 'pastOnly' : c ? 'curOnly' : 'none';
        st.lagCls[cls]++; K.lagCls[cls]++;
        if (tr.blocked) { st.lagBlocked++; K.lagBlocked++; }
        this.session.sendGame({ t: 'ma', m: this.mt.gen, k: tr.aid, h: tr.hit ? 1 : 0, v: tr.measured && tr.kAlive ? 1 : 0, kx: r1(tr.kx), rx: r1(tr.rx),
          c: c ? 1 : 0, rw: Math.min(1000, Math.round(tr.lagMs || 0)), pk: r1(tr.pk), ...(tr.guarded ? { g: 1 } : {}) });
      }
      tr.action = null;
    }

    // HOST：命中した（既存の Combat.resolve → receiveHit の後）。命中イベントを送る
    // Phase 8：被弾する直前のガードの様子（診断：なぜガードにならなかったか）
    guardPre(victim) {
      const g = KG.game;
      const held = victim === g.cpu ? !!(this.remote && this.remote.last.hg) : !!(g.player.controller && g.player.controller.lastGuard);
      return { guarding: victim.isGuarding(), state: victim.guardState, held, grounded: victim.grounded };
    }
    // Phase 8：HOST でガードが成立した（Combat.resolve の既存の判定。正面から・ガード有効中）
    onHostGuard(victim, gd) {
      if (!this.active || this.role !== 'HOST') return;
      const g = KG.game, st = this.st;
      const attacker = gd.attacker;
      const ai = attacker === g.player ? 0 : attacker === g.cpu ? 1 : -1;
      if (ai < 0) return;
      const vi = victim === g.player ? 0 : 1;
      st.gd[vi].guard++;
      let k = 0, pid;
      if (gd.source && gd.source !== attacker) { k = gd.source.naid || 2; pid = gd.source.npid; }   // 泡をガード
      else {
        const tr = st.atk[ai];
        const act = attacker.action || tr.action;
        if (tr.action) tr.guarded = true;
        k = act && act.aid ? act.aid : (gd.move ? kindOfMove(gd.move) : 0);
      }
      const msg = { t: 'mh', m: this.mt.gen, id: ++st.hitSeq, a: ai, k, d: victim.status.damage, x: r1(gd.point.x), y: r1(gd.point.y), w: r1(now()), g: 1 };
      if (pid) msg.p = pid;
      this.session.sendGame(msg);
      this.log('GUARD #' + st.hitSeq + ' ' + (ai === 0 ? 'コタロ→ルミポ' : 'ルミポ→コタロ') + ' (attack ' + k + (pid ? ', projectile ' + pid : '') + ')');
    }

    onHostHit(victim, hit, pre) {
      if (!this.active || this.role !== 'HOST') return;
      const g = KG.game, st = this.st;
      const attacker = hit.attacker;
      const ai = attacker === g.player ? 0 : attacker === g.cpu ? 1 : -1;
      if (ai < 0) return;
      // Phase 8：通常 HIT の数と、ガードを押していたのに HIT になった理由（背面 / 出始め 3F / 空中）
      if (pre) {
        const G = st.gd[victim === g.player ? 0 : 1];
        G.hit++;
        if (pre.guarding) G.back++;
        else if (pre.state === 'startup') G.startup++;
        else if (pre.held && !pre.grounded) G.air++;
      }
      // Phase 7：泡の命中（攻撃側は泡。発射した側の今の技とは関係ない）。遅延補償なし・今の状態で既存処理が判定済み
      if (hit.source && hit.source !== attacker) {
        const pr = hit.source;
        if (victim === g.player) st.kotaroHits++;
        st.bub[ai].hits++;
        if (pr.npid) this.session.sendGame({ t: 'mh', m: this.mt.gen, id: ++st.hitSeq, a: ai, k: pr.naid || 2, d: victim.status.damage, x: r1(hit.point.x), y: r1(hit.point.y), w: r1(now()), p: pr.npid });
        this.log('HIT #' + st.hitSeq + ' 泡 ' + (ai === 0 ? 'コタロ→ルミポ' : 'ルミポ→コタロ') + ' (projectile ' + pr.npid + ', damage ' + victim.status.damage + '%)');
        return;
      }
      const tr = st.atk[ai];
      if (tr.action) tr.hit = true;
      // 攻撃 ID（相打ちで攻撃側の技が先に消えていても、記録しておいた技の ID を使う。種類は命中した技から）
      const act = attacker.action || tr.action;
      const aid = act && act.aid ? act.aid : (hit.move ? kindOfMove(hit.move) : 0);
      // Phase 5：命中の瞬間に「今の位置なら当たったか」「過去の位置なら当たったか」を記録（被弾の回数を増やす前に）
      if (ai === 1 && victim === g.player && tr.action) {
        // 相打ちでは同じステップで攻撃側（ルミポ）も先に被弾して技が消えていることがあるので、記録しておいた技から判定の矩形を作る
        const a0 = attacker.action || tr.action;
        const hbs0 = activeHitboxes(attacker, a0);
        const past0 = a0 && a0.lag && a0.lag.ticks > 0 ? this.pastHurtboxes(st.stepCount + 1 - a0.lag.ticks) : null;
        const cur0 = KG.Fighter.prototype.getHurtboxes.call(victim);
        if (overlapAny(hbs0, cur0)) tr.curHit = true;
        if (overlapAny(hbs0, past0 || cur0)) tr.pastHit = true;
        if (past0) st.lagViz = { cur: cur0, past: past0, hbs: hbs0, until: now() + 700 };   // 診断表示：判定が出た最初のフレームで当たった時も描く
      }
      if (victim === g.player) st.kotaroHits++;   // Phase 5：被弾した後は、被弾前の位置へは巻き戻さない（下の pastHurtboxes）
      // Phase 5：遅延補償があったから当たった（今の位置では当たっていない）命中 = HOST から見て「避けたのに当たった」候補
      if (ai === 1 && victim === g.player) {
        const hbs = activeHitboxes(attacker, attacker.action || tr.action);
        const cur = KG.Fighter.prototype.getHurtboxes.call(victim);
        if (hbs.length && !overlapAny(hbs, cur)) {
          const gap = gapBetween(hbs, cur);
          const K = st.hk[tr.kind || 0];
          const c3 = gap <= 20 ? 0 : gap <= 60 ? 1 : 2;     // ほぼ触れている / 少し逃げた / はっきり逃げた
          st.lagOnlyHits++; st.escGap.add(gap); st.escCls[c3]++;
          K.lagOnlyHits++; K.escGap.add(gap); K.escCls[c3]++;
        }
      }
      this.session.sendGame({ t: 'mh', m: this.mt.gen, id: ++st.hitSeq, a: ai, k: aid, d: victim.status.damage, x: r1(hit.point.x), y: r1(hit.point.y), w: r1(now()) });
      this.log('HIT #' + st.hitSeq + ' ' + (ai === 0 ? 'コタロ→ルミポ' : 'ルミポ→コタロ') + ' (attack ' + aid + ', damage ' + victim.status.damage + '%)');
    }

    sendState() {
      const g = KG.game;
      const st = this.st;
      const f = g.fighters.slice(0, 2).map((fi) => {
        const s = fi.status;
        const code = Math.max(0, STATES.indexOf(fi.state));
        const flags = (s.isAlive ? 1 : 0) | (fi.grounded ? 2 : 0) | (code << 2) | (fi.hitstop > 0 ? 32 : 0) | (fi.hitstun > 0 ? 64 : 0) |
          (fi.action && kindOfMove(fi.action.move) === 1 ? 128 : 0) | (fi.action && kindOfMove(fi.action.move) === 2 ? 256 : 0) |   // Phase 6 / 7：技の種類
          (fi.guardState === 'startup' || fi.guardState === 'active' ? 512 : 0) | (fi.guardState === 'stun' ? 1024 : 0);           // Phase 8：ガード
        // [7] 蓄積ダメージ / [8] 技のフレーム（-1 = なし）/ [9] 傾き（被弾時の回転）
        // [10] 残りストック / [11] KO 回数（命の番号。Phase 9）
        return [r1(fi.x), r1(fi.y), r1(fi.vx), r1(fi.vy), fi.facing < 0 ? -1 : 1, flags, Math.min(60, Math.round(s.invincibleTimer * 100) / 100),
          s.damage, fi.action ? fi.action.frame : -1, Math.round(fi.angle * 100) / 100, s.stocks, st.ko.count[fi === g.player ? 0 : 1]];
      });
      // a = 適用済みの最新入力番号 / p = ルミポの移動に関わる値（予測の作り直し用。丸めない）
      const ok = this.session.sendGame({ t: 'st', s: ++st.stateSeq, h: r1(g.time * 1000), w: r1(now()), a: this.remote.lastApplied, f, p: getLogic(g.cpu), b: this.hostBubbles(), r: st.ko.result, m: this.mt.gen, l: MT_CODE[g.phase] || 0 });
      if (ok) {
        st.stateRate.hit();
        st.sentTicks.set(st.stateSeq, st.stepCount);   // Phase 5：この番号の状態はこのステップのもの
        if (st.sentTicks.size > CFG.sentStates) st.sentTicks.delete(st.sentTicks.keys().next().value);
      }
    }

    // ---------------- Phase 7：泡（HOST） ----------------
    // 既存の spawnFrom で泡が出た：オンライン用の Projectile ID・攻撃 ID・発射時刻を付ける（出なかった時 pr = null：同時 2 個など）
    onHostSpawn(owner, pr) {
      if (!this.active || !pr) return;
      const g = KG.game, st = this.st;
      const ai = owner === g.player ? 0 : owner === g.cpu ? 1 : -1;
      if (ai < 0) return;
      pr.npid = ++st.projSeq;
      pr.nowner = ai;
      pr.naid = owner.action && owner.action.aid ? owner.action.aid : 0;
      const tr = st.atk[ai];
      if (tr.action && tr.action === owner.action) tr.spawned = true;
      const B = st.bub[ai];
      B.spawned++; st.projTotal++;
      const self = this;
      pr.getActiveHitboxes = function () { self.projAttacking = true; return KG.Projectile.prototype.getActiveHitboxes.call(this); };
    }
    // 既存の removeDead の直前：消える泡ごとに消滅イベントを 1 回だけ送る（理由・位置・HOST 時刻）
    onHostRemoveDead() {
      if (!this.active) return;
      const g = KG.game, st = this.st;
      for (const pr of g.projectiles.list) {
        if (!pr.dead || !pr.npid || pr.nSent) continue;
        pr.nSent = true;
        const r = DEATH_CODES[pr.deathReason] != null ? DEATH_CODES[pr.deathReason] : 4;
        const B = st.bub[pr.nowner];
        B.dead[r]++;
        this.session.sendGame({ t: 'pe', m: this.mt.gen, i: pr.npid, r, x: r1(pr.x), y: r1(pr.y), h: r1(g.time * 1000), k: pr.naid, o: pr.nowner });
      }
    }
    // 状態に載せる「場にある泡」（最大 4 個：コタロ 2 + ルミポ 2）
    hostBubbles() {
      const out = [];
      for (const pr of KG.game.projectiles.list) {
        if (pr.dead || !pr.npid || out.length >= 4) continue;
        out.push([pr.npid, pr.nowner, r1(pr.x), r1(pr.y), pr.vx < 0 ? -1 : 1, Math.min(600, Math.round(pr.age / KG.CONFIG.fixedStep)), pr.naid]);
      }
      return out;
    }

    // ---------------- Phase 5：遅延補償（HOST） ----------------
    // GUEST の攻撃押下を適用した瞬間に、巻き戻し量を決める。参照は「HOST 自身が送った状態の番号」だけを信用する
    computeRewind(c) {
      const st = this.st;
      const curTick = st.stepCount + 1;                      // 今進めているステップ
      if (c.rs == null) { st.noRef++; return { ticks: 0, ms: 0, status: 'none' }; }
      const t0 = st.sentTicks.get(c.rs);
      if (t0 == null) {   // 送っていない番号（未来・存在しない・古すぎて記録に無い）→ 補償しない（今の位置で判定）
        st.invalidRewind++;
        this.log('invalid rewind reference (state ' + c.rs + ') → no compensation', 'warn');
        return { ticks: 0, ms: 0, status: 'invalid' };
      }
      const t1 = st.sentTicks.has(c.rs + 1) ? st.sentTicks.get(c.rs + 1) : t0 + CFG.stateEverySteps;
      const refTick = t0 + (c.rf / 1000) * (t1 - t0);
      if (refTick > curTick) { st.invalidRewind++; return { ticks: 0, ms: 0, status: 'invalid' }; }   // 未来は参照できない
      let ticks = curTick - refTick;
      const cap = CFG.lagMaxMs / 1000 / KG.CONFIG.fixedStep;
      let status = 'ok';
      if (ticks > cap) { ticks = cap; status = 'cap'; st.capHits++; }   // 上限より昔は見ない（上限まで）
      const ms = ticks * KG.CONFIG.fixedStep * 1000;
      st.rewindMs.add(ms);
      if (c.pa) st.hk[0].rewindMs.add(ms);
      if (c.ps) st.hk[1].rewindMs.add(ms);
      return { ticks, ms, status };
    }

    // 過去のステップ（小数可）のコタロの位置（履歴の前後 2 つから補間）
    kotaroAt(tick) {
      const h = this.st.hist;
      if (!h.length) return null;
      if (tick >= h[h.length - 1].tick) return h[h.length - 1];
      if (tick <= h[0].tick) return h[0];
      for (let i = h.length - 1; i > 0; i--) {
        const a = h[i - 1], b = h[i];
        if (a.tick <= tick && tick <= b.tick) {
          const k = (tick - a.tick) / Math.max(1, b.tick - a.tick);
          return { x: lerp(a.x, b.x, k), y: lerp(a.y, b.y, k), facing: k < 0.5 ? a.facing : b.facing, alive: a.alive && b.alive };
        }
      }
      return h[0];
    }
    // 過去の位置のコタロの Hurtbox（既存のキャラ定義の hurtboxes をそのまま使う）。
    // 安全のため、参照する過去から今までの間に「場外・復帰」「被弾」「瞬間移動（1 ステップで 200 以上）」があった時は巻き戻さない（今の位置で判定）
    pastHurtboxes(tick, hitsRef) {
      const st = this.st, h = st.hist, g = KG.game;
      const hits = hitsRef == null ? st.kotaroHits : hitsRef;
      if (!g.player.status.isAlive) return null;
      for (let i = h.length - 1; i >= 0 && h[i].tick >= Math.floor(tick); i--) {
        const e = h[i], prev = h[i - 1];
        const newest = hitsRef != null && e.tick === st.stepCount;   // 診断（ステップ後）で呼ばれた時：このステップの命中は数えない
        if (!e.alive || (!newest && e.hits !== hits) || (prev && Math.abs(e.x - prev.x) + Math.abs(e.y - prev.y) > 200)) return null;
      }
      const p = this.kotaroAt(tick);
      if (!p || !p.alive) return null;
      const def = KG.game.player.def;
      return def.hurtboxes.map((b) => KG.util.orientBox(p.x, p.y, p.facing, b));
    }
    // Combat.resolve から呼ばれるコタロの Hurtbox：ルミポ（GUEST）の近接攻撃の判定が出ている間で、遅延補償 ON の時だけ過去の位置。
    // Phase 6：技の種類では分けない。GUEST の押下から決めた巻き戻し量（a.lag）を持ち、体の攻撃判定が今出ている技なら同じ規則で使う。
    //   参照するのは「今 − 巻き戻し量」のステップ。巻き戻し量は技の間ずっと一定なので、startup のある技（クラゲ電撃 9F）でも
    //   GUEST の画面で判定が出た瞬間に見えていたコタロ（押した時に見ていたコタロ + startup の分だけ進んだ位置）を参照する。
    //   複数フレームの判定（クラゲ電撃 5F）は各フレームでその時点に見えていた位置。1 回の技で同じ相手に 1 回だけ当たるのは既存の hitVictims のまま。
    lagHurtboxes() {
      if (!this.active || this.role !== 'HOST' || !this.lagEnabled || this.projAttacking) return null;   // 泡の判定には使わない（Phase 7）
      const g = KG.game, a = g.cpu.action;
      if (!a || !isLagCompMove(a.move) || !a.lag || !(a.lag.ticks > 0) || !g.cpu.getActiveHitboxes().length) return null;
      return this.pastHurtboxes(this.st.stepCount + 1 - a.lag.ticks);
    }

    setLagComp(on) {
      this.lagEnabled = !!on;
      this.renderPredBtn();
      this.renderDiag();
      if (this.active) this.log('lag compensation ' + (on ? 'ON' : 'OFF'));
    }

    // 診断表示中だけ：今のコタロの Hurtbox（実線）と、遅延補償で参照した過去の Hurtbox（点線）、ルミポの攻撃判定（赤）
    drawLagViz(alpha) {
      const st = this.st, g = KG.game;
      if (!this.active || !st || !st.lagViz || st.lagViz.until < now() || this.hud.classList.contains('diag-off')) return;
      const ctx = g.ctx, view = g.camera.getView(alpha), { w, h, dpr } = g.screen;
      const s = view.scale * dpr;
      ctx.save();
      ctx.setTransform(s, 0, 0, s, dpr * (w / 2 - view.cx * view.scale), dpr * (h / 2 - view.cy * view.scale));
      ctx.lineWidth = 3 / view.scale;
      ctx.strokeStyle = 'rgba(120, 220, 255, 0.95)';
      for (const r of st.lagViz.cur) ctx.strokeRect(r.x, r.y, r.w, r.h);
      ctx.setLineDash([10 / view.scale, 6 / view.scale]);
      ctx.strokeStyle = 'rgba(255, 220, 120, 0.95)';
      for (const r of st.lagViz.past) ctx.strokeRect(r.x, r.y, r.w, r.h);
      ctx.setLineDash([]);
      ctx.strokeStyle = 'rgba(255, 90, 110, 0.9)';
      for (const hb of st.lagViz.hbs) ctx.strokeRect(hb.rect.x, hb.rect.y, hb.rect.w, hb.rect.h);
      ctx.restore();
    }

    // ---------------- GUEST ----------------
    guestStep(dt) {
      const g = KG.game;
      if (!this.active) return;
      g.time += dt;
      this.updateGuestPhase(dt);   // Phase 10：段階の移り変わりは HOST の合図（ml）だけ。ここでは表示の時間を進めるだけ
      const st0 = this.st;
      st0.flash[0] = Math.max(0, st0.flash[0] - dt); st0.flash[1] = Math.max(0, st0.flash[1] - dt);
      // Phase 6：表示用キャラの再使用待ち（HUD の必殺ゲージの見た目だけ。判定には使わない）
      for (const fi of [g.player, g.cpu]) for (const id in fi.cooldowns) { fi.cooldowns[id] = Math.max(0, fi.cooldowns[id] - dt); if (!fi.cooldowns[id]) delete fi.cooldowns[id]; }
      this.sampleInput(dt);
      this.applyView(dt);
      this.updateBubbles(dt);
      this.expirePredAttacks();
      g.effects.update(dt);
      g.camera.setTargets(g.activeEntities());
      g.camera.update(dt);
      g.background.update(dt);
    }

    // 自分の入力（キーボード・タッチ。既存の InputManager に集まる）を読み、1 ステップ 1 件として送る（60 回/秒）。
    // 同じ入力を予測用ルミポにもすぐ適用する（HOST の返事を待たない）
    sampleInput(dt) {
      const st = this.st;
      // Phase 9 / 10：対戦中（HOST が GO を確定した後・決着の前）以外は何も押していない入力だけを送る（押したものは読み捨てる。
      //   押した回数も増やさないので、カウントダウン中・勝敗表示中に押したものが GO の後に出ることはない。HOST が入力待ちで警告しないよう送信は続ける）
      const fighting = this.guestFighting();
      const polled = KG.game.input.poll();
      const cmd = fighting ? polled : KG.createEmptyCommand();
      const l = cmd.moveX < -CFG.stickThreshold ? 1 : 0;
      const r = cmd.moveX > CFG.stickThreshold ? 1 : 0;
      const j = cmd.held.jump ? 1 : 0;
      const pj = cmd.pressed.jump ? 1 : 0;
      const pa = cmd.pressed.attack ? 1 : 0;
      const ps = cmd.pressed.special ? 1 : 0;
      const pb = cmd.pressed.shoot ? 1 : 0;
      const gd = cmd.held.guard ? 1 : 0;                // Phase 8：ガードは押しているかの状態（毎回の入力に載せる）
      if (pb) st.bp++;                                  // Phase 7：泡も同じ
      if (pj) st.jp++;                                  // 押した瞬間を回数で数える（押しっぱなしでは増えない）
      if (pa) st.ap++;                                  // 攻撃も同じ（押しっぱなしでは増えない）
      if (ps) st.sp++;                                  // Phase 6：必殺も同じ
      const t = now();
      const s = ++st.inputSeq;
      const msg = { t: 'mi', s, l, r, j, jp: st.jp, ap: st.ap, sp: st.sp, bp: st.bp, g: gd, ts: r1(t), m: this.mt.gen };   // Phase 10：m = 今の試合の番号
      // Phase 5 / 6：攻撃・必殺を押した入力だけ、その瞬間の画面のコタロがどの HOST 状態だったか（番号と割合）を付ける。座標は送らない
      if ((pa || ps) && st.viewRef) { msg.rs = st.viewRef.s; msg.rf = Math.round(st.viewRef.k * 1000); }
      if (!this.session.sendGame(msg)) return; // 切断中は予測もしない
      if (pa) { st.lastPressSent = s; st.gk[0].pressSent++; }
      if (ps) { st.lastSpecialSent = s; st.gk[1].pressSent++; }
      if (pb) { st.lastShootSent = s; st.gk[2].pressSent++; }
      if (gd && !st.cur.g) st.guardPressAt = t;          // Phase 8：押してから HOST の状態に反映されるまで（往復）を測る
      st.cur = { l, r, j, jp: st.jp, g: gd };
      st.lastInputSentAt = t;
      st.inputRate.hit();
      st.sentTimes.set(s, t);
      if (st.sentTimes.size > 240) st.sentTimes.delete(st.sentTimes.keys().next().value);
      if (!fighting) return;   // Phase 10：対戦中以外は予測しない（未確認入力にも積まない）
      // 未確認入力として覚えておく（HOST の a で確認済みになったら捨てる）
      const c = { s, mx: r - l, hj: j, hg: gd, pj, pa, ps, pb, t };
      st.pending.push(c);
      if (st.pending.length > CFG.maxPending) { st.pending.shift(); st.pendingDropped++; }
      this.predictStep(c, dt);
    }

    // 予測：既存の Fighter.update() をそのまま 1 回呼ぶ（HOST の RemoteInputController と同じコマンドの作り方）
    predictStep(c, dt) {
      const f = this.pred, st = this.st;
      if (!f || st.predHidden || !this.guestFighting()) return;   // Phase 9 / 10：対戦中以外は予測しない（HOST の状態だけ）
      if (this.ackStalled()) return;   // HOST が入力を確認していない：先へ進めない（HOST の状態に従う）
      const wasGuard = f.guardState !== 'none';
      const started = applyCmd(f, c, KG.game.stage);
      // Phase 8：予測でガードの姿勢が始まった（押してから画面に出るまでの時間を診断に）
      if (!wasGuard && f.guardState !== 'none') {
        const ka = st.keyAt[3], tn = now();
        if (ka && tn - ka >= 0 && tn - ka < 300) st.gg.keyToGuard.add(tn - ka);
        st.keyAt[3] = 0;
      }
      if (started && !st.predAttacks.has(started.aid)) {
        // 攻撃・必殺の予測開始（見た目だけ。命中は判定しない）。結果は HOST から届く
        st.ghost = null;
        const kind = kindOfAid(started.aid), G = st.gk[kind];
        G.predStarted++;
        const ka = st.keyAt[kind], tn = now();
        // キー / ボタンを押してから予測で技が始まるまで（押したステップでそのまま始まった時だけ。先行入力で後から出た技は数えない）
        if (ka && tn - ka >= 0 && tn - ka < 300 && [c.pa, c.ps, c.pb][kind]) G.keyToPred.add(tn - ka);
        st.keyAt[kind] = 0;
        st.predAttacks.set(started.aid, { t: c.t, kind, visHit: false, kxDisp: null, rxDisp: null, measured: false, done: false, accepted: false });
      }
      // Phase 7：予測で泡が出た（技の 8F 目）→ 予測泡（見た目だけ）。同時 2 個までは既存の spawnFrom と同じ規則
      if (f.lastSpawns && f.lastSpawns.length && f.action) {
        for (const ev of f.lastSpawns) this.spawnPredBubble(f, ev.spawn, f.action.aid);
      }
      if (KG.game.stage.isOutOfBounds(f)) st.predHidden = true;   // 場外へ出た：HOST の判定（復帰）を待つ
    }

    // 予測の作り直し（reconciliation）：HOST の確定状態 + まだ確認されていない入力 → 今の予測
    reconcile(m) {
      const st = this.st, f = this.pred;
      if (!f || !m.p) return;
      while (st.pending.length && st.pending[0].s <= m.a) st.pending.shift();  // HOST が適用済みの入力は捨てる
      const alive = !!(m.f[1][5] & 1);
      st.lastInv = m.f[1][6];
      // Phase 8：HOST が認識しているルミポのガード状態（診断）。押してから HOST に反映されて戻ってくるまでの時間
      st.gg.hostGuard = m.p[25];
      if (m.p[25] > 0 && st.guardPressAt) { st.gg.keyToHost.add(now() - st.guardPressAt); st.guardPressAt = 0; }
      if (!alive) { st.hostAlive = false; st.predHidden = true; return; }   // 場外・復帰待ち：HOST の判定に従う
      // Phase 9：命の番号（HOST の KO 回数）が変わった = HOST がリスポーンを確定した。死亡前の予測を残さない
      const respawned = m.f[1][11] !== st.ko.life;
      if (respawned) this.onGuestRespawn(m.f[1][11]);
      const wasHidden = st.predHidden || !st.hostAlive || respawned;
      st.hostAlive = true;
      // HOST で始まった攻撃の ID（受理の確認）
      if (m.p[12] >= 0 && m.p[17] && !st.acceptedAids.has(m.p[17])) {
        st.acceptedAids.add(m.p[17]);
        if (st.acceptedAids.size > 200) st.acceptedAids.delete(st.acceptedAids.values().next().value);
        st.lastHostAid = m.p[17];
        const G = st.gk[kindOfAid(m.p[17])];
        G.accepted++;
        const pa = st.predAttacks.get(m.p[17]);
        if (pa) { pa.accepted = true; const d = now() - pa.t; st.acceptRtt.add(d); G.acceptRtt.add(d); }
      }
      const bx = f.x, by = f.y;
      const beforeAct = f.action ? { move: f.action.move, frame: f.action.frame, aid: f.action.aid } : null;
      // 被弾・命中が絡む作り直しか（HOST の被弾結果を優先する）
      const hitRelated = m.p[14] > 0 || m.p[15] > 0 || st.hitPending;
      st.hitPending = false;
      setLogic(f, m.p);
      st.predHidden = false;
      const dt = KG.CONFIG.fixedStep;
      // HOST が 500ms 以上入力を確認していない（通信が詰まっている・HOST がニュートラルにした）間は、
      // 未確認入力を重ねず HOST の状態をそのまま使う（通信が止まった時に、自分の画面だけ動き続けないように）
      const stalled = this.ackStalled();
      if (stalled !== st.wasStalled) { st.wasStalled = stalled; if (stalled) { st.stallCount++; this.log('inputs not acknowledged for ' + CFG.inputTimeoutMs + 'ms → prediction paused', 'warn'); } }
      const fighting = this.guestFighting();
      if (!fighting) st.pending.length = 0;          // Phase 9 / 10：対戦中以外は未確認入力を重ねない（HOST は対戦中以外の入力を使わない）
      if (!stalled && fighting) for (const c of st.pending) applyCmd(f, c, KG.game.stage);
      void dt;
      // HOST で攻撃が出なかった（予測していた攻撃が作り直しで消えた）：見た目だけ最後まで再生して自然に終える（被弾中は即座にやめる）
      // Phase 6：クラゲ電撃がまだ溜め（startup）なら、溜めの終わりまでで止める（HOST で出ていない放電・音は出さない）
      // Phase 9：場外・復帰待ちから戻った時（リスポーン）は、隠れる前の技を見た目で続けない
      if (beforeAct && !wasHidden && !f.action && f.hitstun === 0 && beforeAct.frame < beforeAct.move.totalFrames) {
        const fa = firstActive(beforeAct.move);
        beforeAct.limit = kindOfMove(beforeAct.move) !== 0 && beforeAct.frame < fa ? fa - 1 : beforeAct.move.totalFrames;   // 電撃・泡は「出る」前で止める
        st.ghost = beforeAct;
      }
      // Phase 7：HOST で出なかった泡の技（予測ではもう泡を出していた）→ 予測泡を薄く消す
      if (beforeAct && kindOfMove(beforeAct.move) === 2 && !f.action && !st.acceptedAids.has(beforeAct.aid)) this.discardPredBubble(beforeAct.aid);
      if (f.action || f.hitstun > 0) st.ghost = null;
      if (KG.game.stage.isOutOfBounds(f)) st.predHidden = true;
      st.reconciles++;
      if (wasHidden) { st.vis.x = 0; st.vis.y = 0; st.respawnSnap = true; return; }   // 復帰した瞬間は HOST の位置から
      // 予測誤差 = 作り直す前の予測位置 − 作り直した後の予測位置（同じ時点の比較）
      const ex = bx - f.x, ey = by - f.y, e = Math.hypot(ex, ey);
      if (hitRelated) {
        // 被弾・命中による差：予測誤差とは分けて数え、速め（30ms）に HOST の結果へ寄せる。大きすぎれば即座に
        if (e > 0) { st.hitErr.add(e); st.hitCorr++; }
        if (!this.predEnabled) return;
        if (e >= CFG.hitSnap) { st.vis.x = 0; st.vis.y = 0; st.hitSnaps++; }
        else { st.vis.x += ex; st.vis.y += ey; st.fastUntil = now() + 150; }
        return;
      }
      st.lastErrX = ex; st.lastErrY = ey;
      st.predErr.add(e);
      if (e > 0) st.nonZeroErr++;
      if (!this.predEnabled) return;
      if (e >= CFG.errSnap) {                         // 致命的な誤差：HOST 状態へ即座に合わせる
        st.vis.x = 0; st.vis.y = 0; st.snapCount++;
        this.log('prediction snap: error ' + e.toFixed(1), 'warn');
      } else {
        // 画面の位置が急に飛ばないよう、差を表示位置のずれとして残し、数フレームで消す（物理の値は変えない）
        st.vis.x += ex; st.vis.y += ey;
        if (e >= CFG.errIgnore) st.corrections++;
      }
    }

    // GUEST：HOST の命中イベント（同じ ID は 1 回だけ）。見た目（エフェクト・音・白く光る）を出し、ダメージ表示を HOST の値にする
    onHitEvent(m) {
      if (!this.active || this.role !== 'GUEST') { this.session.stats.dropped++; return; }
      if (m.m !== this.mt.gen) { this.mtStats.staleMatch++; return; }   // Phase 10：前の試合の命中
      const st = this.st, g = KG.game;
      // 同じ命中番号は 1 回だけ（二重のエフェクト・音・ダメージ表示を出さない）。古すぎる番号（64 件以上前）も捨てる
      // （Phase 6：同じステップの相打ちでは命中が 2 件続けて届く。番号の集合で判定し、届く順番には頼らない）
      if (st.hitRecvIds.has(m.id) || m.id <= st.lastHitId - 64) { st.gg.dup++; return; }   // Phase 8：重複の数（診断）
      st.hitRecvIds.add(m.id);
      if (st.ko.over) { st.ko.lateHits++; return; }   // Phase 9：試合終了後の命中は表示もダメージも反映しない（HOST は終了後に判定しない）
      // Phase 8：同じ攻撃（攻撃 ID・泡なら Projectile ID）で HIT と GUARD の両方が来たら数える（既存の hitVictims により本来 0）
      const rkey = m.a + ':' + (m.p ? 'p' + m.p : m.k);
      if (st.gg.results.has(rkey)) st.gg.double++;
      st.gg.results.set(rkey, m.g ? 'G' : 'H');
      if (st.gg.results.size > 200) st.gg.results.delete(st.gg.results.keys().next().value);
      if (m.g) return this.onGuardEvent(m);
      if (st.hitRecvIds.size > 128) st.hitRecvIds.delete(st.hitRecvIds.values().next().value);
      st.lastHitId = Math.max(st.lastHitId, m.id);
      st.hitRecv++; st.gg.hitRecv++;
      if (m.a === 0) { st.gg.hitMine++; if (this.pred && this.pred.isGuarding()) st.gg.mismatch++; }   // 予測ではガードしていたのに HOST は HIT
      const kind = kindOfAid(m.k), G = st.gk[kind], move = moveOfKind(kind);
      G.hitRecv++;
      const off = this.session.clockOffset;
      if (off != null) { const d = Math.max(0, now() - (m.w - off)); st.hitShowDelay.add(d); G.hitShow.add(d); }
      const attacker = m.a === 0 ? g.player : g.cpu, victim = m.a === 0 ? g.cpu : g.player;
      victim.status.damage = m.d;
      st.flash[m.a === 0 ? 1 : 0] = 0.18;
      if (m.a === 0) st.hitPending = true;        // 自分（ルミポ）が被弾：次の作り直しは HOST の被弾結果を優先
      if (m.a === 1) { const rec = st.predAttacks.get(m.k); if (rec) rec.hostHit = true; }
      // 命中の見た目・音は既存のもの（クラゲ電撃は電撃のヒット演出 'shock' と電撃音を重ねる）。命中番号ごとに 1 回だけ
      if (kind === 2) {   // Phase 7：泡の命中。音は既存の軽い命中音、見た目は泡が弾ける演出（消滅イベント pe で 1 回）
        st.gb.hits++;
        try { if (KG.sound) KG.sound.play('hitLight'); } catch (_) { /* noop */ }
        return;
      }
      const hb = move.hitboxes[0];
      try { g.effects.spawnHit(m.x, m.y, KG.util.sign(victim.x - attacker.x) || 1, hb.hitEffect); } catch (_) { /* noop */ }
      try {
        if (KG.sound) {
          const scale = KG.Knockback.scale(Math.max(0, m.d - (hb.damage || 0)), hb);   // 既存の音と同じ「強い吹っ飛び」の目安
          KG.sound.play('hit', { s: HIT_SE[move.id] != null ? HIT_SE[move.id] : 0.6, heavy: Math.min(1.2, Math.max(0, scale - 1.5)) / 1.2 });
          if (kind === 1) KG.sound.play('hitZap');
        }
      } catch (_) { /* noop */ }
    }

    // ---------------- Phase 7：泡（GUEST の表示） ----------------
    // 泡の表示は 2 通り：
    //   own  … 自分（ルミポ）の予測泡。予測のルミポと同じ「今」の時刻で、発射位置 + 速さ × 経過時間（既存の泡と同じ式）で動かす
    //   host … コタロの泡・予測していなかった泡。コタロの補間と同じ時刻（renderH）で、HOST の位置 + 速さ × 時間差で出す
    // どちらも見た目だけ。命中・消滅を決めるのは HOST（消滅イベント pe）。消えた ID は二度と出さない。
    wob(age) { const w = BUBBLE_DEF().wobble; return w ? Math.sin(age * w.freq) * w.amp : 0; }
    ownBubbleCount() {
      let n = 0;
      for (const b of this.st.bubbles.values()) if (b.owner === 1 && !b.ended && b.fade == null) n++;
      return n;
    }
    newBubble(o) {
      const g = KG.game;
      const obj = Object.create(KG.Projectile.prototype);   // 描画は既存の泡の描き方（RENDERERS.bubble）をそのまま使う
      Object.assign(obj, { def: BUBBLE_DEF(), owner: o.owner === 0 ? g.player : g.cpu, x: 0, y: 0, prevX: 0, prevY: 0, vx: o.dir * BUBBLE_DEF().speed, vy: 0,
        age: 0, life: BUBBLE_DEF().lifetime, phase: Math.random() * Math.PI * 2, dead: false, hitVictims: new Set(), facing: o.dir });
      return Object.assign({ pid: null, aid: 0, ox: 0, oy: 0, age: 0, ended: false, popped: false, fired: false, fade: null, shown: false, born: now(), lastSeen: now(), obj }, o);
    }
    // 予測：技の 8F 目に泡を出す（既存の spawnFrom と同じ位置・向き）。攻撃 ID で仮に識別し、HOST の泡が届いたら引き継ぐ
    spawnPredBubble(f, spawn, aid) {
      const st = this.st;
      if (st.bubbles.has('a' + aid) || this.ownBubbleCount() >= BUBBLE_DEF().maxPerOwner) return;
      const b = this.newBubble({ owner: 1, mode: 'own', aid, dir: f.facing, x0: f.x + f.facing * spawn.x, by0: f.y + spawn.y });
      st.bubbles.set('a' + aid, b);
      st.gb.predSpawned++;
    }
    discardPredBubble(aid) {
      const b = this.st.bubbles.get('a' + aid);
      if (!b || b.pid || b.fade != null) return;
      b.fade = 0.15;                                         // 0.15 秒で薄く消す（弾ける演出・音は出さない）
      this.st.gb.discarded++;
    }
    // HOST 状態の「場にある泡」：新しい泡を出す / 予測泡に ID を引き継ぐ / HOST の位置を記録
    syncBubbles(m) {
      const st = this.st, dt = KG.CONFIG.fixedStep, sp = BUBBLE_DEF().speed;
      const seenAids = new Set();
      for (const e of m.b) {
        const [pid, o, x, y, dir, n, aid] = e;
        if (st.deadPids.has(pid)) continue;                  // 消えた泡は復活させない
        seenAids.add(aid);
        const host = { x, y, n, h: m.h, dir };
        let b = st.bubbles.get('p' + pid);
        if (!b && o === 1) {
          const pb = st.bubbles.get('a' + aid);
          if (pb && !pb.pid) b = this.linkBubble(pb, pid, host);
        }
        if (!b) {
          b = this.newBubble({ owner: o, mode: 'host', aid, dir, pid });
          st.bubbles.set('p' + pid, b);
          if (o === 1) st.gb.hostOnly++;
        }
        b.host = host; b.lastSeen = now();
        if (b.mode === 'own' && b.fade == null) {
          // 引き継いだ後のずれ（同じ経過時間で比べた、自分の画面の泡と HOST の泡の位置の差）
          const a = n * dt;
          st.gb.resid.add(Math.hypot(b.x0 + b.ox + dir * sp * a - x, b.by0 + b.oy + this.wob(a) - y));
        }
      }
      // 予測泡のうち、HOST でその技が 8F を過ぎても泡が出ていない（同時 2 個・被弾など）→ 消す
      for (const b of st.bubbles.values()) {
        if (b.mode !== 'own' || b.pid || seenAids.has(b.aid)) continue;
        if (m.p[17] === b.aid && m.p[12] > 10) this.discardPredBubble(b.aid);
      }
    }
    linkBubble(b, pid, host) {
      const st = this.st, dt = KG.CONFIG.fixedStep, sp = BUBBLE_DEF().speed;
      const a = host.n * dt;
      const x0 = host.x - host.dir * sp * a, by0 = host.y - this.wob(a);
      const err = Math.hypot(x0 - b.x0, by0 - b.by0);
      st.gb.linkErr.add(err); st.gb.linked++;
      if (host.dir !== b.dir || err > 120) { b.ox = 0; b.oy = 0; b.dir = host.dir; b.obj.vx = host.dir * sp; }   // 大きなずれ：HOST に合わせる
      else { b.ox += b.x0 - x0; b.oy += b.by0 - by0; }                                                     // 小さなずれ：表示は続けたまま短時間で寄せる
      b.x0 = x0; b.by0 = by0; b.pid = pid;
      st.bubbles.delete('a' + b.aid);
      st.bubbles.set('p' + pid, b);
      return b;
    }
    // HOST で泡が消えた（ID ごとに 1 回）
    onProjEvent(m) {
      if (!this.active || this.role !== 'GUEST') { this.session.stats.dropped++; return; }
      if (m.m !== this.mt.gen) { this.mtStats.staleMatch++; return; }   // Phase 10：前の試合の泡
      const st = this.st;
      if (st.deadPids.has(m.i)) return;
      st.deadPids.add(m.i);
      if (st.deadPids.size > 200) st.deadPids.delete(st.deadPids.values().next().value);
      st.gb.dead[m.r]++;
      let b = st.bubbles.get('p' + m.i);
      if (!b && m.o === 1) { const pb = st.bubbles.get('a' + m.k); if (pb && !pb.pid) { b = pb; b.pid = m.i; st.bubbles.delete('a' + m.k); st.bubbles.set('p' + m.i, b); st.gb.linked++; } }
      if (!b) return;
      if (b.mode === 'host' && m.r !== 0) { b.deathH = m.h; b.deathR = m.r; return; }   // コタロの補間の時刻がそこへ来た時に消す
      this.endBubble(b, m.r);
    }
    // 泡を終わらせる（弾ける演出・音は 1 回だけ。場外は演出なし）
    endBubble(b, r) {
      if (!b.popped && !b.ended && b.shown && b.fade == null && r <= 2) {
        b.popped = true;
        try { KG.game.effects.spawnBubblePop(b.obj.x, b.obj.y, BUBBLE_DEF().radius, r === 0); } catch (_) { /* noop */ }
        try { if (KG.sound) KG.sound.play('bubblePop'); } catch (_) { /* noop */ }
      }
      b.ended = true; b.remove = true;
    }
    // 毎ステップ：泡の表示位置を進め、表示用の一覧（既存の ProjectileSystem の list）を作り直す
    updateBubbles(dt) {
      const st = this.st, g = KG.game, def = BUBBLE_DEF(), sp = def.speed;
      const list = [];
      const tH = st.renderH;
      for (const [key, b] of st.bubbles) {
        if (b.remove) { st.bubbles.delete(key); continue; }
        const o = b.obj;
        let x, y, age;
        if (b.mode === 'own') {
          b.age += dt; age = b.age;
          const k = Math.exp(-(dt * 1000) / 90);              // 引き継ぎ時のずれを 90ms で消す
          b.ox *= k; b.oy *= k;
          x = b.x0 + b.ox + b.dir * sp * age; y = b.by0 + b.oy + this.wob(age);
        } else {
          if (!b.host || tH == null) continue;
          const d = (tH - b.host.h) / 1000;
          age = b.host.n * KG.CONFIG.fixedStep + d;
          if (age < 0) continue;                                 // コタロの表示の時刻ではまだ発射前
          if (b.deathH != null && tH >= b.deathH) { this.endBubble(b, b.deathR); st.bubbles.delete(key); continue; }
          if (now() - b.lastSeen > 800 && b.deathH == null) { st.bubbles.delete(key); continue; }   // 念のため（消滅イベントが無いまま状態から消えた）
          x = b.host.x + b.dir * sp * d; y = b.host.y - this.wob(b.host.n * KG.CONFIG.fixedStep) + this.wob(age);
        }
        if (b.fade != null) { b.fade -= dt; if (b.fade <= 0) { st.bubbles.delete(key); continue; } }
        if (b.ended) { if (now() - b.born > 3000) st.bubbles.delete(key); continue; }
        // 自分の予測泡：寿命・地形・場外は見た目だけ先に終える（HOST の消滅イベントで消す。二重には弾けない）
        if (b.mode === 'own' && b.fade == null) {
          const s2 = def.size / 2, r = { x: x - s2, y: y - s2, w: def.size, h: def.size };
          const bz = g.stage.blastZone;
          if (age >= def.lifetime) { b.shown = true; o.x = x; o.y = y; this.endBubble(b, 2); b.remove = false; continue; }
          if (g.stage.solids.some((sd) => KG.util.rectsOverlap(r, sd))) { b.shown = true; o.x = x; o.y = y; this.endBubble(b, 1); b.remove = false; continue; }
          if (x < bz.left || x > bz.right || y < bz.top || y > bz.bottom) { b.ended = true; continue; }
        }
        o.prevX = b.shown ? o.x : x; o.prevY = b.shown ? o.y : y;
        o.x = x; o.y = y; o.age = age; o.vx = b.dir * sp;
        o.life = b.fade != null ? b.fade : def.lifetime - age;
        if (!b.shown) {
          b.shown = true;
          if (!b.fired && age < 0.15) {                          // 発射の音・泡粒（泡 1 個につき 1 回。引き継いでも鳴らし直さない）
            b.fired = true;
            try { g.effects.spawnBubblePuff(x, y, b.dir); } catch (_) { /* noop */ }
            try { if (KG.sound) KG.sound.play('bubbleFire'); } catch (_) { /* noop */ }
          }
        }
        list.push(o);
      }
      // 予測泡が HOST から確認されないまま一定時間：HOST では出なかった → 消す
      const limit = Math.min(1200, 250 + 2 * (st.reflect.avg || 100));
      for (const b of st.bubbles.values()) if (b.mode === 'own' && !b.pid && b.fade == null && !b.ended && now() - b.born > limit) this.discardPredBubble(b.aid);
      g.projectiles.list = list;
    }

    // Phase 8：HOST でガードが成立した（命中番号ごとに 1 回）。既存のガードの演出・音。ダメージ・吹っ飛びなし（押し戻しと硬直は HOST の状態で来る）
    onGuardEvent(m) {
      const st = this.st, g = KG.game;
      st.gg.guardRecv++;
      const attacker = m.a === 0 ? g.player : g.cpu, victim = m.a === 0 ? g.cpu : g.player;
      victim.status.damage = m.d;
      if (m.a === 0) {                          // 自分（ルミポ）がガード：次の作り直しは HOST の結果（押し戻し・硬直）を優先
        st.hitPending = true; st.gg.guardMine++;
        if (this.pred && !this.pred.isGuarding()) st.gg.mismatch++;   // 予測ではガードしていなかったのに HOST はガード
      }
      try { g.effects.spawnGuard(m.x, m.y, KG.util.sign(attacker.x - victim.x) || victim.facing); } catch (_) { /* noop */ }
      try { if (KG.sound) KG.sound.play('guard'); } catch (_) { /* noop */ }
    }

    // ---------------- Phase 9：KO・ストック・勝敗（GUEST の表示。決めるのは HOST） ----------------
    // HOST の KO イベント（KO 番号ごとに 1 回）。場外の演出・音は既存の onKnockOut。ストックは HOST の値をそのまま使う（引き算しない）
    onKOEvent(m) {
      if (!this.active || this.role !== 'GUEST') { this.session.stats.dropped++; return; }
      if (m.m !== this.mt.gen) { this.mtStats.staleMatch++; return; }   // Phase 10：前の試合の KO
      const K = this.st.ko, g = KG.game;
      if (K.ids.has(m.id)) { K.dup++; return; }
      K.ids.add(m.id);
      if (K.ids.size > 64) K.ids.delete(K.ids.values().next().value);
      K.events++;
      this.syncStocks(m.s, m.n, m.v);
      try { g.onKnockOut(m.v === 0 ? g.player : g.cpu, { x: m.x, y: m.y }); } catch (_) { /* noop */ }
      if (m.v === 1) { this.st.hostAlive = false; this.st.predHidden = true; this.st.ghost = null; }   // 自分（ルミポ）の KO：リスポーンは HOST の状態を待つ
      if (m.r && !K.over) this.finishGuestMatch(m.r);
    }
    // 残りストック：HOST の値（KO 回数が今より古くない時だけ。古い値で戻さない）
    syncStocks(stocks, count, i) {
      const K = this.st.ko;
      if (count < K.count[i]) return;
      K.count[i] = count; K.stocks[i] = stocks;
    }
    // HUD 用の場にいるか / 復帰待ち / KO（ストック 0）。既存の RulesHud がそのまま表示する
    setDisplayLife(fi, i, alive) {
      const K = this.st.ko;
      fi.status.stocks = K.stocks[i];
      fi.status.lifeState = alive ? 'alive' : K.stocks[i] <= 0 ? 'ko' : 'respawning';
    }
    // HOST が自分（ルミポ）のリスポーンを確定した：予測用ルミポは呼び出し元で HOST の状態に置き換える。ここでは死亡前の予測を捨てる
    //   （見た目だけ続けていた技・HOST で確認されていない予測泡・表示のずれ・被弾補正）。未確認入力のうち HOST が適用済みの分は捨て済みで、
    //   残りはリスポーン後に HOST が適用する入力なので、そのまま適用し直す（HOST と同じ結果になる）
    onGuestRespawn(life) {
      const st = this.st;
      st.ko.life = life;
      st.ghost = null; st.hitPending = false; st.fastUntil = 0;
      st.vis.x = 0; st.vis.y = 0;
      for (const b of st.bubbles.values()) if (b.owner === 1 && b.mode === 'own' && !b.pid) this.discardPredBubble(b.aid);
      if (life > 0) st.ko.respawns[1]++;
    }
    // HOST が試合終了を確定した（KO イベント or 状態の r。1 回だけ）。以後は予測・入力・命中を使わない
    finishGuestMatch(code) {
      const st = this.st, K = st.ko;
      if (K.over) return;
      K.over = true; K.result = code; K.endAt = now();
      this.applyResult(code);
      if (this.mt.state === 'fight' || this.mt.state === 'countdown') this.mt.state = 'ending';   // Phase 10（勝敗表示へは HOST の合図で）
      st.pending.length = 0; st.ghost = null;
      for (const b of st.bubbles.values()) if (b.fade == null && !b.ended) b.fade = 0.15;   // 残っている泡は薄く消す（HOST も消している）
      this.log('MATCH END: ' + KG.game.result);
    }
    // 勝敗表示が出た瞬間（GUEST）：ジングルは自分（ルミポ）が勝ったかで選ぶ（既存の SoundSystem はコタロ視点のため、同じ瞬間の自動再生を止める）
    onGuestResultShown() {
      const snd = KG.sound, g = KG.game;
      if (!snd) return;
      try { snd.prevPhase = 'result'; snd.play(g.winner === g.cpu ? 'jingleWin' : 'jingleLose'); } catch (_) { /* noop */ }
    }

    // GUEST：自分の攻撃の HOST での結果（HIT / MISS と、判定が出た瞬間の HOST 上の位置）。見た目との比較（診断）だけに使う
    onAttackResult(m) {
      if (!this.active || this.role !== 'GUEST') { this.session.stats.dropped++; return; }
      if (m.m !== this.mt.gen) { this.mtStats.staleMatch++; return; }   // Phase 10：前の試合の攻撃の結果
      const st = this.st;
      const rec = st.predAttacks.get(m.k);
      const G = st.gk[kindOfAid(m.k)];
      if (!rec) { st.hostOnly++; if (m.h) G.hits++; else G.misses++; return; }
      if (rec.done && rec.resulted) return;
      if (rec.done && !rec.accepted) { st.hostRejectedPred--; G.hostRejectedPred--; }   // 時間切れで「出なかった」と数えた後に結果が届いた
      rec.done = true; rec.resulted = true;
      if (m.h) G.hits++; else G.misses++;
      if (m.g) { G.guarded = (G.guarded || 0) + 1; return; }   // Phase 8：ガードされた攻撃は「見た目×HOST」の比較に入れない
      const vis = rec.visHit, host = !!m.h;
      const cell = (vis ? 'v' : 'm') + (host ? 'v' : 'm'), cellCur = (vis ? 'v' : 'm') + (m.c ? 'v' : 'm');
      st.matrix[cell]++; G.matrix[cell]++;
      st.matrixCur[cellCur]++; G.matrixCur[cellCur]++;   // Phase 5：同じ攻撃を「今の位置」で判定した場合（HOST の診断値）
      st.gRewind.add(m.rw); G.gRewind.add(m.rw);
      if (m.v && rec.measured) {
        st.dKotaro.add(Math.abs(rec.kxDisp - m.kx)); G.dKotaro.add(Math.abs(rec.kxDisp - m.kx));
        st.dRuimpo.add(Math.abs(rec.rxDisp - m.rx));
        st.dKotaroPast.add(Math.abs(rec.kxDisp - m.pk)); G.dKotaroPast.add(Math.abs(rec.kxDisp - m.pk));   // 自分の画面のコタロと、HOST が遅延補償で参照したコタロの差
      }
    }

    // GUEST：予測した攻撃のうち、HOST の結果が来ないまま時間が過ぎたもの = HOST では出なかった
    expirePredAttacks() {
      const st = this.st, t = now();
      for (const [aid, rec] of st.predAttacks) {
        if (!rec.done && t - rec.t > CFG.attackResultTimeoutMs) { rec.done = true; if (!rec.accepted) { st.hostRejectedPred++; st.gk[rec.kind || 0].hostRejectedPred++; } }
        if (rec.done && t - rec.t > 5000) st.predAttacks.delete(aid);
      }
    }

    // 一番古い未確認入力が inputTimeoutMs（HOST がニュートラルにする時間）より古いか
    ackStalled() {
      const p = this.st.pending;
      return p.length > 0 && now() - p[0].t > CFG.inputTimeoutMs;
    }

    // 予測 ON / OFF（GUEST だけ。実験中いつでも切り替えられる。表示位置は急に飛ばずに滑らかにつながる）
    setPrediction(on) {
      this.predEnabled = !!on;
      if (this.st) { this.st.blend = true; this.st.blendUntil = now() + 400; }
      this.renderPredBtn();
      this.renderDiag();
      if (this.active) this.log('prediction ' + (on ? 'ON' : 'OFF'));
    }
    renderPredBtn() {
      const b = this.$ && this.$.predBtn;
      if (!b) return;
      b.textContent = this.predEnabled ? '予測 ON' : '予測 OFF';
      b.classList.toggle('is-on', this.predEnabled);
      const lb = this.$.lagBtn;
      if (lb) { lb.textContent = this.lagEnabled ? 'LagComp ON' : 'LagComp OFF'; lb.classList.toggle('is-on', this.lagEnabled); }
    }

    onState(m) {
      if (!this.active || this.role !== 'GUEST') { this.session.stats.dropped++; return; }
      if (m.m !== this.mt.gen) { this.mtStats.staleMatch++; return; }   // Phase 10：別の試合の状態（試合の合図 ml より前・前の試合）は使わない
      const st = this.st;
      if (m.s <= st.lastStateSeqRecv) { st.staleStates++; return; }  // 古い・重複・逆順の状態は捨てる
      const t = now();
      st.lastStateSeqRecv = m.s;
      st.lastStateAt = t;
      st.stateRate.hit();
      st.waitingFirstState = false;
      // HOST のゲーム内時刻 → 自分の時計への対応。届くのが早かった（遅延が小さかった）値に素早く寄せ、遅い値にはゆっくり寄せる
      const sample = m.h - t;
      if (st.tOff == null) st.tOff = sample;
      else st.tOff += (sample - st.tOff) * (sample > st.tOff ? 0.25 : 0.02);
      st.snaps.push({ h: m.h, f: m.f, s: m.s });
      st.latestF = m.f;
      if (st.snaps.length > 60) st.snaps.shift();
      // 入力 → HOST で反映 → その結果の状態が届く、までの往復時間（入力番号 a で対応付け）
      if (m.a > st.lastAcked) {
        const sentAt = st.sentTimes.get(m.a);
        if (sentAt != null) st.reflect.add(t - sentAt);
        st.lastAcked = m.a;
      }
      const off = this.session.clockOffset;
      if (off != null) st.stateDelay.add(Math.max(0, t - (m.w - off)));
      this.syncStocks(m.f[0][10], m.f[0][11], 0);
      this.syncStocks(m.f[1][10], m.f[1][11], 1);
      if (m.l === 2) this.enterGuestFight(m.w);              // Phase 10：GO の合図（ml）より先に状態で知った時も同じ処理（1 回だけ）
      if (m.r && !st.ko.over) this.finishGuestMatch(m.r);   // Phase 9：KO イベントより先に状態で終了を知った時も同じ処理（1 回だけ）
      this.reconcile(m);
      this.syncBubbles(m);
    }

    // HOST の状態を interpDelayMs だけ遅らせた時刻で、前後 2 つの状態から補間して表示（予測はしない）
    applyView(dt) {
      const st = this.st;
      const snaps = st.snaps;
      if (snaps.length && st.tOff != null) this.applyInterpolated();
      this.applyRuimpo(dt);
    }

    // GUEST のルミポ：予測 ON なら予測用 Fighter の位置 + 表示のずれ、OFF なら Phase 2 と同じ補間の位置
    applyRuimpo(dt) {
      const st = this.st, g = KG.game, fi = g.cpu, f = this.pred;
      const interp = st.interpCpu;                      // applyInterpolated() が計算したルミポの補間結果
      let base, alive;
      if (this.predEnabled && f) {
        base = { x: f.x, y: f.y, vx: f.vx, vy: f.vy, facing: f.facing, grounded: f.grounded, state: f.state };
        alive = st.hostAlive && !st.predHidden;
      } else if (interp) {
        base = interp; alive = interp.alive;
      } else return;
      const prevX = fi.x, prevY = fi.y;
      if (st.blend) {                                   // ON / OFF を切り替えた瞬間：今の表示位置からつなぐ
        st.vis.x = fi.x - base.x; st.vis.y = fi.y - base.y; st.blend = false;
        if (Math.hypot(st.vis.x, st.vis.y) > CFG.errSnap * 3) { st.vis.x = 0; st.vis.y = 0; }
      }
      // 表示のずれを時間で消す（大きいほど速く）。物理の値には触らない
      const mag = Math.hypot(st.vis.x, st.vis.y);
      if (mag > 0) {
        // ON / OFF 切替直後は、つなぎ目が目立たないようゆっくり（120ms）
        const tau = st.blendUntil > now() ? 120 : st.fastUntil > now() ? CFG.hitTauMs : mag > CFG.errSmall ? CFG.tauLargeMs : CFG.tauSmallMs;
        const k = Math.exp(-(dt * 1000) / tau);
        st.vis.x *= k; st.vis.y *= k;
        if (Math.hypot(st.vis.x, st.vis.y) < 0.05) { st.vis.x = 0; st.vis.y = 0; }
      }
      const wasAlive = fi.status.isAlive;
      fi.x = base.x + st.vis.x; fi.y = base.y + st.vis.y;
      fi.prevX = prevX; fi.prevY = prevY;
      if ((alive && !wasAlive) || st.respawnSnap) { fi.prevX = fi.x; fi.prevY = fi.y; st.respawnSnap = false; }
      fi.vx = base.vx; fi.vy = base.vy; fi.facing = base.facing; fi.grounded = base.grounded; fi.state = base.state;
      this.setDisplayLife(fi, 1, alive);
      fi.status.invincibleTimer = this.predEnabled ? st.lastInv : base.inv;
      // ---- Phase 4：技・被弾の見た目 ----
      let act = null, hitstop = 0, hitstun = 0, angle = 0;
      if (this.predEnabled && f) {
        if (f.action) act = f.action;
        else if (st.ghost) {   // HOST で出なかった予測攻撃：見た目だけ最後まで（クラゲ電撃の溜めは溜めの終わりまで）
          st.ghost.frame++;
          act = st.ghost.frame <= (st.ghost.limit || st.ghost.move.totalFrames) ? st.ghost : (st.ghost = null);
        }
        hitstop = f.hitstop; hitstun = f.hitstun; angle = f.angle;
      } else if (interp) {
        act = interp.actFrame >= 0 ? { move: moveOfKind(interp.kind), frame: interp.actFrame } : null;
        hitstop = interp.hitstop; hitstun = interp.hitstun; angle = interp.angle;
      }
      this.setDisplayAction(1, fi, act, hitstop, hitstun, angle, st.flash[1]);
      // Phase 8：ガードの姿勢（予測 ON は予測用ルミポのまま＝押した次のフレームから。OFF は HOST の状態）。描画は既存の Fighter.draw / drawGuard
      if (this.predEnabled && f) { fi.guardState = f.guardState; fi.guardFrames = f.guardFrames; fi.guardFacing = f.guardFacing; }
      else if (interp) this.setDisplayGuard(fi, interp.flags, interp.facing);
      if (st.latestF) fi.status.damage = st.latestF[1][7];
      // 見た目の当たり（診断だけ。命中の判定には使わない）：自分の画面で、予測した攻撃の判定がコタロに重なって見えたか
      if (this.predEnabled && f && f.action && f.action === act) {
        const rec = st.predAttacks.get(f.action.aid);
        const hbs = fi.getActiveHitboxes();
        if (rec && hbs.length) {
          if (!rec.measured) { rec.measured = g.player.status.isAlive; rec.kxDisp = g.player.x; rec.rxDisp = fi.x; }
          if (g.player.status.isAlive) {
            const hurt = g.player.getHurtboxes();
            for (const hb of hbs) for (const hu of hurt) if (KG.util.rectsOverlap(hb.rect, hu)) rec.visHit = true;
          }
        }
      }
    }

    // 表示用 Fighter に技・被弾の見た目を設定（描画は既存の Fighter.draw がそのまま行う）
    setDisplayAction(idx, fi, act, hitstop, hitstun, angle, flash) {
      this.showAction(idx, fi, act);
      fi.hitstop = hitstop; fi.hitstun = hitstun;
      fi.prevAngle = fi.angle; fi.angle = angle;
      fi.shake = hitstop > 0 && hitstun > 0 ? 1 : 0;
      fi.flash = flash;
    }

    // Phase 8：状態のフラグからガードの見た目を設定（512 = 出始め・有効 / 1024 = 硬直）。ガード中の向きは体の向きと同じ
    setDisplayGuard(fi, flags, facing) {
      fi.guardState = flags & 1024 ? 'stun' : flags & 512 ? 'active' : 'none';
      fi.guardFrames = 99; fi.guardFacing = facing;
    }

    // Phase 6：表示中の技。同じ技（攻撃 ID が同じ / ID が無ければ同じ技でフレームが進んでいる間）は同じ action オブジェクトを使い続け、
    // 既存の効果音・演出（溜め・放電）をその技につき 1 回だけ出す。作り直し・状態の受信が何度あっても二重に出ない
    showAction(idx, fi, act) {
      const st = this.st;
      const d = st.disp[idx] || (st.disp[idx] = { obj: null, last: null, lastAt: 0, seen: new Map() });
      const prev = d.obj;
      if (!act) {
        if (prev) { d.last = prev; d.lastAt = now(); this.onDisplayEnd(fi, prev); }
        d.obj = null; fi.action = null;
        return;
      }
      let o = null;
      const cand = prev || (now() - d.lastAt < 250 ? d.last : null);   // 一瞬だけ技が消えて戻った（作り直し・補間の境目）時も同じ技として扱う
      if (cand && cand.move === act.move && (act.aid != null ? cand.aid === act.aid : act.frame >= cand.frame - 3)) o = cand;
      if (!o && act.aid != null && d.seen.has(act.aid)) { const s0 = d.seen.get(act.aid); if (s0.move === act.move) o = s0; }
      const fresh = !o;
      if (fresh) {
        if (prev) this.onDisplayEnd(fi, prev);
        o = { move: act.move, frame: act.frame, hitVictims: NO_VICTIMS, aid: act.aid, cueSe: {}, cueFx: {} };
        if (act.aid != null) { d.seen.set(act.aid, o); if (d.seen.size > 32) d.seen.delete(d.seen.keys().next().value); }
      }
      o.frame = act.frame;
      d.obj = o;
      fi.action = o;
      this.moveCues(fi, o, fresh);
    }
    // 表示中の技が終わった：コタロの必殺ゲージ（HUD）の見た目だけ再使用待ちにする
    onDisplayEnd(fi, o) {
      if (o.move.cooldown && !fi.cooldowns[o.move.id]) fi.cooldowns[o.move.id] = o.move.cooldown;
    }
    // 技の効果音（開始・指定フレーム）と演出（技データの fx）を、その技につき 1 回だけ出す（既存の Effects・効果音をそのまま使う）
    moveCues(fi, o, fresh) {
      const se = MOVE_SE[o.move.id];
      const play = (n) => { try { if (KG.sound) KG.sound.play(n); } catch (_) { /* noop */ } };
      if (fresh && se && se.start && o.frame <= 6) play(se.start);
      if (se && se.frames) {
        for (const k in se.frames) {
          const f0 = Number(k);
          if (o.cueSe[f0]) continue;
          if (o.frame >= f0) { o.cueSe[f0] = true; if (o.frame <= f0 + 4) play(se.frames[k]); }
        }
      }
      const list = o.move.fx || [];
      for (let i = 0; i < list.length; i++) {
        if (o.cueFx[i]) continue;
        const fx = list[i];
        const end = fx.frame + Math.max(1, Math.round((fx.duration || fx.active || 0) * 60));
        if (o.frame < fx.frame) continue;
        o.cueFx[i] = true;
        if (o.frame >= end) continue;                    // 気づいた時にはもう終わっていた（大きく遅れた状態）：出さない
        try {
          const fxs = KG.game.effects;
          fxs.spawnMoveFx({ fx, action: o, owner: fi });
          const e = fxs.list[fxs.list.length - 1];
          if (e && e.action === o) e.t = (o.frame - fx.frame) / 60;   // 途中から見えた時は途中から
        } catch (_) { /* noop */ }
      }
    }

    // HOST の状態の補間（コタロは常にこれ。ルミポは予測 OFF の時だけ使う）
    applyInterpolated() {
      const st = this.st;
      const snaps = st.snaps;
      const renderH = now() + st.tOff - CFG.interpDelayMs;
      st.renderH = renderH;   // Phase 7：コタロの泡も同じ時刻で表示する
      while (snaps.length > 2 && snaps[1].h <= renderH - 500) snaps.shift();   // 古すぎる状態は捨てる
      let A = null, B = null;
      for (let i = snaps.length - 1; i >= 0; i--) {
        if (snaps[i].h <= renderH) { A = snaps[i]; B = snaps[i + 1] || null; break; }
      }
      const g = KG.game;
      st.extrapolating = false;
      // Phase 5：今コタロの表示に使っている HOST 状態の番号と、次の状態までの割合（攻撃を押した時に HOST へ伝える）
      if (A) {
        const k = B ? (renderH - A.h) / Math.max(1, B.h - A.h) : (renderH - A.h) / (1000 * KG.CONFIG.fixedStep * CFG.stateEverySteps);
        st.viewRef = { s: A.s, k: Math.min(3, Math.max(0, k)) };
      } else st.viewRef = snaps.length ? { s: snaps[0].s, k: 0 } : null;
      g.fighters.slice(0, 2).forEach((fi, idx) => {
        let x, y, src;
        if (!A) { src = snaps[0].f[idx]; x = src[0]; y = src[1]; }          // まだ最初の状態より前
        else if (!B) {
          // 新しい状態がまだ無い：速度で少しだけ先へ（最大 maxExtrapolateMs）。それ以上は止めて待つ
          src = A.f[idx];
          const e = Math.min(CFG.maxExtrapolateMs, Math.max(0, renderH - A.h)) / 1000;
          x = src[0] + src[2] * e;
          y = src[1] + (src[5] & 2 ? 0 : src[3] * e);
          if (renderH - A.h > 1) st.extrapolating = true;
        } else {
          const a = A.f[idx], b = B.f[idx];
          const k = Math.min(1, Math.max(0, (renderH - A.h) / Math.max(1, B.h - A.h)));
          src = k < 0.5 ? a : b;
          // 場にいるかが違う・命の番号が違う（Phase 9：KO をはさむ）2 つの状態の間は補間しない
          if (Math.hypot(b[0] - a[0], b[1] - a[1]) > CFG.snapDistance || !(a[5] & 1) !== !(b[5] & 1) || a[11] !== b[11]) { x = src[0]; y = src[1]; }
          else { x = lerp(a[0], b[0], k); y = lerp(a[1], b[1], k); }
        }
        const alive = !!(src[5] & 1);
        if (idx === 1) {   // ルミポは applyRuimpo() で表示する
          st.interpCpu = { x, y, vx: src[2], vy: src[3], facing: src[4], grounded: !!(src[5] & 2), state: STATES[(src[5] >> 2) & 7] || 'idle', alive, inv: src[6],
            actFrame: src[8], kind: src[5] & 128 ? 1 : src[5] & 256 ? 2 : 0, flags: src[5], hitstop: src[5] & 32 ? 1 : 0, hitstun: src[5] & 64 ? 1 : 0, angle: src[9] };
          return;
        }
        const wasAlive = fi.status.isAlive;
        fi.prevX = fi.x; fi.prevY = fi.y;
        fi.x = x; fi.y = y;
        if (alive && !wasAlive) { fi.prevX = x; fi.prevY = y; }  // 復帰した瞬間は前の位置から滑らせない
        fi.vx = src[2]; fi.vy = src[3];
        fi.facing = src[4];
        fi.grounded = !!(src[5] & 2);
        fi.state = STATES[(src[5] >> 2) & 7] || 'idle';
        this.setDisplayLife(fi, 0, alive);
        fi.status.invincibleTimer = src[6];
        // コタロの技・被弾の見た目（HOST の状態のまま）とダメージ
        this.setDisplayAction(0, fi, src[8] >= 0 ? { move: moveOfKind(src[5] & 128 ? 1 : src[5] & 256 ? 2 : 0), frame: src[8] } : null, src[5] & 32 ? 1 : 0, src[5] & 64 ? 1 : 0, src[9], st.flash[0]);
        this.setDisplayGuard(fi, src[5], src[4]);   // Phase 8：コタロのガード（HOST の状態）
        if (st.latestF) fi.status.damage = st.latestF[0][7];
      });
      if (st.extrapolating) st.extrapCount++;
    }

    // ---------------- 画面（操作実験中だけの小さな表示・GUEST のタッチ操作） ----------------
    buildDom() {
      const root = document.getElementById('game-root') || document.body;
      const hud = this.hud = document.createElement('div');
      hud.id = 'ol-move-hud';
      hud.hidden = true;
      hud.innerHTML =
        '<div class="olm-top">' +
          '<span class="olm-badge">ONLINE TEST・3ストック</span>' +
          '<span class="olm-role"></span>' +
          '<button type="button" class="olm-btn olm-pred" data-olm="pred">予測 ON</button>' +
          '<button type="button" class="olm-btn olm-lag" data-olm="lag">LagComp ON</button>' +
          '<button type="button" class="olm-btn" data-olm="diag">診断</button>' +
          '<button type="button" class="olm-btn olm-end" data-olm="end">実験を終了</button>' +
        '</div>' +
        '<pre class="olm-diag"></pre>' +
        '<p class="olm-hint">移動：<kbd>A</kbd><kbd>D</kbd> / <kbd>←</kbd><kbd>→</kbd>　ジャンプ：<kbd>Space</kbd> <kbd>W</kbd> <kbd>↑</kbd>　攻撃（ぽよんアタック）：<kbd>J</kbd>　必殺（クラゲ電撃）：<kbd>K</kbd>　泡（バブルショット）：<kbd>L</kbd>　ガード：<kbd>I</kbd></p>';
      root.appendChild(hud);
      // Phase 9：勝敗表示（既存の #ko-overlay）に、オンライン実験の時だけ出す案内（「もう一度」「タイトルへ戻る」は CSS で隠す）
      //   Phase 10：「もう一度」（両方が押したら次の試合）・「終了する」（接続画面へ）と、相手を待っているかの表示
      const ov = document.getElementById('ko-overlay');
      if (ov) {
        const box = document.createElement('div');
        box.className = 'ko-online';
        box.innerHTML = '<p class="ko-online-status" aria-live="polite"></p><div class="ko-online-actions">' +
          '<button type="button" class="menu-btn primary" data-olr="again">もう一度</button><button type="button" class="menu-btn ghost" data-olr="quit">終了する</button></div>';
        ov.appendChild(box);
      }
      this.$ = { role: hud.querySelector('.olm-role'), diag: hud.querySelector('.olm-diag'), predBtn: hud.querySelector('[data-olm="pred"]'), lagBtn: hud.querySelector('[data-olm="lag"]') };
      const bindBtn = (el, fn) => {
        el.addEventListener('pointerdown', (e) => { e.stopPropagation(); el._armed = e.pointerId; });
        el.addEventListener('pointerup', (e) => { e.stopPropagation(); if (el._armed === e.pointerId) fn(); el._armed = null; });
        el.addEventListener('click', (e) => { if (e.detail === 0) fn(); });
      };
      bindBtn(hud.querySelector('[data-olm="end"]'), () => { if (KG.sound) KG.sound.play('back'); this.end(); });
      if (ov) {
        const q = (k) => ov.querySelector('[data-olr="' + k + '"]');
        this.$.res = { status: ov.querySelector('.ko-online-status'), again: q('again') };
        bindBtn(q('again'), () => { if (!this.$.res.again.disabled) this.requestRematch(); });
        bindBtn(q('quit'), () => { if (KG.sound) KG.sound.play('back'); this.end(); });
      }
      bindBtn(hud.querySelector('[data-olm="diag"]'), () => hud.classList.toggle('diag-off'));
      bindBtn(this.$.predBtn, () => { if (KG.sound) KG.sound.play('select'); this.setPrediction(!this.predEnabled); });
      bindBtn(this.$.lagBtn, () => { if (KG.sound) KG.sound.play('select'); this.setLagComp(!this.lagEnabled); });
      if (window.matchMedia && matchMedia('(pointer: coarse)').matches) hud.classList.add('diag-off'); // スマホは最初は畳む

      // GUEST 用のタッチ操作：左に LEFT / RIGHT（指を滑らせて切り替え可）、右に JUMP。マルチタッチ対応
      const pad = this.pad = document.createElement('div');
      pad.id = 'ol-pad';
      pad.innerHTML =
        '<div class="olp-dir" aria-label="左右移動"><span class="olp-key" data-dir="-1">◀<small>LEFT</small></span><span class="olp-key" data-dir="1">▶<small>RIGHT</small></span></div>' +
        '<div class="olp-atk" aria-label="攻撃"><span>●<small>攻撃</small></span></div>' +
        '<div class="olp-sp" aria-label="必殺"><span>✦<small>必殺</small></span></div>' +
        '<div class="olp-sh" aria-label="泡"><span>◎<small>泡</small></span></div>' +
        '<div class="olp-gd" aria-label="防御"><span>◇<small>防御</small></span></div>' +
        '<div class="olp-jump" aria-label="ジャンプ"><span>▲<small>JUMP</small></span></div>';
      root.appendChild(pad);
      const dir = pad.querySelector('.olp-dir');
      const keys = dir.querySelectorAll('.olp-key');
      this.padState = { dirId: null, dir: 0 };
      const setDir = (d) => {
        this.padState.dir = d;
        keys.forEach((k) => k.classList.toggle('pressed', Number(k.dataset.dir) === d));
        try { KG.game.input.setAxis('olpad', d, 0); } catch (_) { /* noop */ }
      };
      const dirFrom = (e) => {
        const r = dir.getBoundingClientRect();
        return e.clientX < r.left + r.width / 2 ? -1 : 1;
      };
      dir.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        if (this.padState.dirId !== null) return;
        this.padState.dirId = e.pointerId;
        try { dir.setPointerCapture(e.pointerId); } catch (_) { /* noop */ }
        setDir(dirFrom(e));
      });
      dir.addEventListener('pointermove', (e) => { if (e.pointerId === this.padState.dirId) setDir(dirFrom(e)); });
      const dirUp = (e) => { if (e.pointerId !== this.padState.dirId) return; this.padState.dirId = null; setDir(0); };
      for (const t of ['pointerup', 'pointercancel', 'lostpointercapture']) dir.addEventListener(t, dirUp);
      // 右側のボタン（JUMP・攻撃）：押している指ごとに既存の InputManager へ「押している」を伝える（押した瞬間は InputManager が記録）
      const buttons = [];
      const bindAction = (el, action, kind) => {
        const ids = new Set();
        el.addEventListener('pointerdown', (e) => {
          e.preventDefault();
          if (kind != null && this.active && this.st) this.st.keyAt[kind] = e.timeStamp || now();   // 診断：タッチから予測開始まで
          ids.add(e.pointerId);
          try { el.setPointerCapture(e.pointerId); } catch (_) { /* noop */ }
          try { KG.game.input.setHeld(action, 'olpad:' + e.pointerId, true); } catch (_) { /* noop */ }
          el.classList.add('pressed');
        });
        const up = (e) => {
          if (!ids.delete(e.pointerId)) return;
          try { KG.game.input.setHeld(action, 'olpad:' + e.pointerId, false); } catch (_) { /* noop */ }
          if (!ids.size) el.classList.remove('pressed');
        };
        for (const t of ['pointerup', 'pointercancel', 'lostpointercapture']) el.addEventListener(t, up);
        buttons.push({ el, action, ids });
      };
      bindAction(pad.querySelector('.olp-jump'), 'jump');
      bindAction(pad.querySelector('.olp-atk'), 'attack', 0);   // Phase 4：攻撃（ぽよんアタック）
      bindAction(pad.querySelector('.olp-sp'), 'special', 1);   // Phase 6：必殺（クラゲ電撃）
      bindAction(pad.querySelector('.olp-sh'), 'shoot', 2);     // Phase 7：泡（バブルショット）
      bindAction(pad.querySelector('.olp-gd'), 'guard', 3);     // Phase 8：防御（押している間ガード）
      this.padReset = () => {
        if (this.padState.dirId !== null) { this.padState.dirId = null; }
        setDir(0);
        for (const b of buttons) {
          for (const id of b.ids) { try { KG.game.input.setHeld(b.action, 'olpad:' + id, false); } catch (_) { /* noop */ } }
          b.ids.clear();
          b.el.classList.remove('pressed');
        }
      };
    }

    // 診断（スクリーンショット 1 枚で読めるよう、技ごとの結果を表にまとめる）
    renderDiag() {
      if (!this.active) return;
      this.renderResultUi();   // Phase 10
      const s = this.session, st = this.st, p = s.ping;
      const ms = (v) => v == null ? '-' : Math.round(v) + 'ms';
      const hz = (v) => v.toFixed(0) + 'Hz';
      const num = (v) => v == null ? '-' : Math.round(v);
      const P = (v, n) => String(v).padStart(n);
      const name = (i) => KIND_NAMES[i] + '　'.repeat(5 - KIND_NAMES[i].length);   // 全角 5 文字分にそろえる
      const mx = (m) => m.vv + '/' + m.vm + '/' + m.mv + '/' + m.mm;
      const pct = (a, b) => b ? Math.round((a / b) * 100) + '%' : '-';
      const lines = ['PING ' + ms(p.last) + '  avg ' + ms(s.pingAvg) + '  (min ' + ms(p.min) + ' / max ' + ms(p.max) + ')'];
      if (this.role === 'HOST') {
        const r = this.remote;
        const L = r.last;
        const inTxt = r.neutral ? 'ニュートラル' : [L.mx < 0 ? 'LEFT' : '', L.mx > 0 ? 'RIGHT' : '', L.hj ? 'JUMP' : ''].filter(Boolean).join('+') || '-';
        lines.push(
          'GUEST入力 ' + hz(st.inputRate.value) + '  seq ' + st.lastInputSeqRecv + '（適用 ' + r.lastApplied + '）未適用 ' + r.queue.length + '  古い ' + st.staleInputs +
            '  続けた ' + r.dupTicks + '  追いつき ' + r.catchUps + (r.overflow ? '  あふれ ' + r.overflow : '') + (st.floodDropped ? '  過多 ' + st.floodDropped : ''),
          '入力が届くまで ' + ms(st.inputDelay.avg) + '（max ' + ms(st.inputDelay.max) + '）  HOST状態 送信 ' + hz(st.stateRate.value) + '  seq ' + st.stateSeq +
            '  ルミポ入力 ' + inTxt + (st.neutralCount ? '  無通信 ' + st.neutralCount : '') + '  命中 ' + st.hitSeq,
          'LagComp ' + (this.lagEnabled ? 'ON' : 'OFF') + '［C］ 上限 ' + CFG.lagMaxMs + 'ms  巻き戻し 平均 ' + num(st.rewindMs.mean) + ' / 中央値 ' + num(st.rewindMs.median) +
            ' / 最大 ' + num(st.rewindMs.max) + 'ms  上限到達 ' + st.capHits + '  invalid参照 ' + st.invalidRewind,
          'ルミポの技  入力 発動 拒否  HIT MISS │押下→開始│ 今も過去も/過去だけ/今だけ/MISS │補償だけHIT(>60)',
        );
        st.hk.slice(0, 2).forEach((K, i) => {
          lines.push(name(i) + P(K.pressRecv, 4) + P(K.accepted, 5) + P(K.rejected, 5) + P(K.hits, 5) + P(K.misses, 5) + ' │' + P(ms(K.startDelay.avg), 7) + '  │ ' +
            (K.lagCls.both + '/' + K.lagCls.pastOnly + '/' + K.lagCls.curOnly + '/' + K.lagCls.none).padEnd(15) + ' │ ' + K.lagOnlyHits + '（' + K.escCls[2] + '）' + (K.lagBlocked ? ' 補償せず ' + K.lagBlocked : ''));
        });
        lines.push(
          '巻き戻し 平均/中央値/最大  ' + st.hk.map((K, i) => KIND_NAMES[i] + ' ' + num(K.rewindMs.mean) + '/' + num(K.rewindMs.median) + '/' + num(K.rewindMs.max) + 'ms').join('  ') +
            '   今−過去の差 ' + st.hk.map((K) => num(K.posDiff.mean)).join(' / '),
          'コタロの技（補償なし）  ' + st.hk.slice(0, 2).map((K, i) => KIND_NAMES[i] + ' 発動 ' + K.kAccepted + ' HIT ' + K.kHits + ' MISS ' + K.kMisses).join('  '),
          // Phase 7：泡（ルミポ / コタロ）。消えた理由 = 命中 / 地形 / 寿命 / 場外
          'バブル  ルミポ 入力 ' + st.hk[2].pressRecv + ' 発射 ' + st.bub[1].spawned + ' 拒否 ' + st.hk[2].rejected + '  コタロ 発射 ' + st.bub[0].spawned +
            ' │ 存在 ' + KG.game.projectiles.list.filter((q) => !q.dead).length + ' / 生成計 ' + st.projTotal +
            ' │ 命中 ' + (st.bub[0].hits + st.bub[1].hits) + ' 地形 ' + (st.bub[0].dead[1] + st.bub[1].dead[1]) + ' 寿命 ' + (st.bub[0].dead[2] + st.bub[1].dead[2]) + ' 場外 ' + (st.bub[0].dead[3] + st.bub[1].dead[3]),
          // Phase 8：ガード。受けた側ごとに GUARD / HIT（HIT のうち：ガード中に背面から / 出始め 3F / 空中で押していた）
          'ガード  GUEST入力 ' + (r.last.hg ? 'ON' : 'OFF') + ' HOST状態 ルミポ ' + KG.game.cpu.guardState + ' / コタロ ' + KG.game.player.guardState +
            ' │ ' + ['コタロ', 'ルミポ'].map((nm, i) => nm + 'が受けた GUARD ' + st.gd[i].guard + ' HIT ' + st.gd[i].hit + '（背面 ' + st.gd[i].back + ' 空中 ' + st.gd[i].air + ' 出始め ' + st.gd[i].startup + '）').join(' / ') +
            ' │ 押す→HOST反映 ' + ms(st.guardApply.avg),
          this.koLine() + '  │ 終了後の押下 ' + st.ko.lateInputs,
          this.matchLine(),
        );
      } else {
        const stall = st.lastStateAt ? now() - st.lastStateAt : null;
        const e = st.predErr;
        lines.push(
          '予測 ' + (this.predEnabled ? 'ON' : 'OFF（補間表示）') + '［P］  入力 送信 ' + hz(st.inputRate.value) + '  HOST状態 受信 ' + hz(st.stateRate.value) + '  未確認 ' + st.pending.length + '件' +
            (st.staleStates ? '  古い状態 ' + st.staleStates : '') + '  コタロ補間 ' + CFG.interpDelayMs + 'ms',
          '予測誤差 平均 ' + (e.avg == null ? '-' : e.avg.toFixed(2)) + ' / 最大 ' + (e.max == null ? '-' : e.max.toFixed(1)) + '（0でない ' + st.nonZeroErr + '/' + st.reconciles + '）  補正 ' + st.corrections + '  snap ' + st.snapCount +
            '  被弾補正 ' + st.hitCorr + '（max ' + (st.hitErr.max == null ? '-' : st.hitErr.max.toFixed(0)) + '）' + (st.hitSnaps ? ' snap ' + st.hitSnaps : '') +
            (this.ackStalled() ? '  ⚠ HOSTが入力を確認していないため予測を停止中' : st.stallCount ? '  予測停止 ' + st.stallCount : ''),
          '入力→HOSTで反映→受信 ' + ms(st.reflect.avg) + '（max ' + ms(st.reflect.max) + '）  HOST状態が届くまで ' + ms(st.stateDelay.avg) + '  外挿 ' + st.extrapCount + 'F' +
            (st.waitingFirstState ? '  HOSTの状態を待っています…' : stall > CFG.stateStallMs ? '  ⚠ HOSTの状態が ' + (stall / 1000).toFixed(1) + '秒 届いていません' : ''),
          '自分の技    入力 予測 発動 拒否  HIT MISS │ 見た目×HOST（HH/HM/MH/MM）│ 今の位置なら',
        );
        st.gk.slice(0, 2).forEach((G, i) => {
          lines.push(name(i) + P(G.pressSent, 4) + P(G.predStarted, 5) + P(G.accepted, 5) + P(G.hostRejectedPred, 5) + P(G.hits, 5) + P(G.misses, 5) + ' │ ' +
            (mx(G.matrix) + ' HIT→MISS ' + pct(G.matrix.vm, G.matrix.vv + G.matrix.vm)).padEnd(22) + '│ ' + mx(G.matrixCur) + ' HIT→MISS ' + pct(G.matrixCur.vm, G.matrixCur.vv + G.matrixCur.vm));
        });
        lines.push('時間        押す→予測 押す→発動確認 HIT→表示 │ 位置の差 画面−今 / 画面−補償の参照（巻き戻し）');
        st.gk.slice(0, 2).forEach((G, i) => {
          lines.push(name(i) + P(ms(G.keyToPred.mean), 8) + P(ms(G.acceptRtt.avg), 13) + P(ms(G.hitShow.avg), 9) + ' │ ' + P(num(G.dKotaro.mean), 6) + ' / ' + num(G.dKotaroPast.mean) + '（' + num(G.gRewind.mean) + 'ms）');
        });
        const gb = st.gb, f1 = (v) => v == null ? '-' : v.toFixed(1);
        lines.push('バブル  入力 ' + st.gk[2].pressSent + ' 予測発射 ' + gb.predSpawned + ' 引継ぎ ' + gb.linked + ' 破棄 ' + gb.discarded + ' 予測なし ' + gb.hostOnly +
          ' │ 表示中 ' + KG.game.projectiles.list.length + ' │ 命中 ' + gb.hits + ' 地形 ' + gb.dead[1] + ' 寿命 ' + gb.dead[2] + ' 場外 ' + gb.dead[3] +
          ' │ 位置誤差 平均 ' + f1(gb.linkErr.mean) + ' 最大 ' + f1(gb.linkErr.max) + '（引継ぎ後 ' + f1(gb.resid.mean) + ' / ' + f1(gb.resid.max) + '）');
        const gg = st.gg, pf = this.pred;
        lines.push('ガード  入力 ' + (st.cur.g ? 'ON' : 'OFF') + ' 予測 ' + (pf ? pf.guardState : '-') + ' HOST ' + GUARD_STATES[gg.hostGuard] +
          ' │ GUARD ' + gg.guardRecv + ' HIT ' + gg.hitRecv + '（自分が受けた GUARD ' + gg.guardMine + ' HIT ' + gg.hitMine + '）' +
          ' │ 予測と不一致 ' + gg.mismatch + ' 重複 ' + gg.dup + ' HIT+GUARD ' + gg.double +
          ' │ 押す→表示 ' + ms(gg.keyToGuard.mean) + ' 押す→HOST反映(往復) ' + ms(gg.keyToHost.mean));
        lines.push(this.matchLine());
        lines.push(this.koLine() + '  │ KOイベント ' + st.ko.events + ' 重複 ' + st.ko.dup + '  リスポーン ' + st.ko.respawns[1] + '  終了後の命中 ' + st.ko.lateHits);
      }
      const text = lines.join('\n');
      if (this.$.diag.textContent !== text) this.$.diag.textContent = text;
    }

    // Phase 9：KO・ストック・勝敗の 1 行（HOST・GUEST 共通。値はどちらも HOST が決めたもの）
    koLine() {
      const K = this.st.ko, g = KG.game;
      const inv = (f) => (f.status.isInvincible ? ' 無敵' + f.status.invincibleTimer.toFixed(1) + 's' : '');
      const res = ['試合中', 'コタロ WIN', 'ルミポ WIN', 'DRAW'][K.result] || '-';
      return 'KO  コタロ stock ' + K.stocks[0] + ' (KO ' + K.count[0] + ')' + inv(g.player) + ' / ルミポ stock ' + K.stocks[1] + ' (KO ' + K.count[1] + ')' + inv(g.cpu) + '  │ ' + res;
    }

    // テスト・確認用
    get stats() { return this.st; }
  }

  OnlineMoveTest.CONFIG = CFG;
  OnlineMoveTest.RemoteInputController = RemoteInputController;
  KG.OnlineMoveTest = OnlineMoveTest;
})(window.KG = window.KG || {});
