/*
 * 《风雨如晦（上）》
 *
 * 作者／主创：玄蝶
 * 开发：ChatGPT、Claude
 * 壁纸与界面美术：ChatGPT
 * 测试、修复与操作体验打磨：Grace_Davis
 * 代码贡献：清风（李牧、周公完整代码）、蝶设堂（桓温，经 ChatGPT 修改）、无名杀团队
 *   荀淑、张芝、彭羕、孟达、孟获、吴苋、罗宪、张华、王衍基于无名杀本体代码，经 ChatGPT 按本作技能修改。
 *
 * 代码按其适用的开源许可使用；壁纸与界面美术不随代码授权，转载或二改请注明出处。
 * 部分素材来自网络，版权归原作者所有，如有侵权请联系删除。
 */

import { lib, game, ui, get, ai, _status } from "../../noname.js";
export const type = "extension";
const silentSkill = {
  forced: true,
  silent: true,
  popup: false
};
const silentRule = {
  charlotte: true,
  ...silentSkill
};
/*
 * 庄周测试脚手架总开关（只改这一处，保存后重启游戏生效）：
 *   true  = 开：出牌阶段自动闭眼、“测试：窥视手牌”按钮、“意象手动标记测试”横幅、
 *           用牌链与“【庄周V2测试】”调试战报；闭眼违规只提示“TEST INVALID”，不判负离场。
 *   false = 关：正式版行为，闭眼只由【寐】【梦】等真实技能进入，违规真的判负离场。
 */
const ZHUANGZHOU_TEST_SCAFFOLD = false;
/*
 * 庄周闭眼规则（只写在注释里：原作者要求游戏内文字极简，规则由玩家从“睁眼／闭眼”字句自行推断，如同线下闭眼打牌）。
 * - 双眼闭上时，看不到自己的手牌、装备区、判定区与其他角色（含其是否阵亡）。
 * - 只“听见”其他角色使用或打出的牌：只显示声明的牌名，不显示花色点数；转化牌只显示声明的牌名，不暴露是否转化。
 *   改判只听见“X发动了【鬼才】”等，不知道用哪张牌改判。其他角色自己装备不被口述。
 * - 被弃置、获得、展示、拼点等的牌一律不可见（牌背）。庄周弃置的牌背面朝上进入弃牌堆。
 * - 弃置自己的牌：由庄周亲手摸选（可弃可不弃时可取消）；木牛流马是否移动也由庄周自己选。其他可选询问随机作答且必定执行。
 * - 闭眼提交的用牌、打出、弃牌或木牛流马目标不符合规则：判负离场（测试模式下仅提示）。张数不对属公开信息，只要求重选。
 * - 梦／醒结算未完成时，庄周其他武将技能失效。
 */
function installXdZhuangzhou(lib, game, ui, get, ai, _status) {
    "use strict";

    lib.xd_utils ||= {};
    if (lib.xd_utils.zhuangzhou) {
        return lib.xd_utils.zhuangzhou;
    }

    const Z = lib.xd_utils.zhuangzhou = {
        revision: "2026-10-12-zz-v355-skilltext-original",
        v2proto: true,
        v2Sessions: new WeakMap(),
        v2ActiveSessions: new Set(),
        tokens: new Map(),
        seats: [],
        serial: 0,
        raw: {},
        modal: null,
        pending: [],
        ended: false,
    };

    const PP = lib.element.Player?.prototype || lib.element.player;
    const skillIds = ["xd_mei", "xd_meng", "xd_xing"];

    Z.state = player => player.storage.xd_zhuangzhou_state ||= {
        closed: 0,
        yin: false,
        lock: null,
        lockRevision: 0,
    };

    Z.owns = player =>
        !!player &&
        skillIds.some(id => player.hasSkill(id, null, false));

    Z.blind = player =>
        Z.owns(player) && Z.state(player).closed === 2;

    Z.local = player =>
        player === game.me &&
        !_status.connectMode &&
        Z.owns(player);

    Z.alive = player =>
        player?.isIn
            ? player.isIn()
            : game.players.includes(player);

    Z.shown = (card, player) => {
        const fn = lib.xd_utils.isShownHandCard;
        if (!fn) {
            throw new Error(
                "庄周需要现有 isShownHandCard(card, player) 接口"
            );
        }
        return !!fn(card, player);
    };

    // 闭眼前记录视觉顺序；闭眼后保留旧牌相对位置，新牌追加。
    // 不修改蔡琰的排序实现，也不依赖 sortHandcardOL。
    Z.hand = player => {
        const cards = player.getCards("h");
        const dom = [
            ...Array.from(player.node.handcards1?.children || []),
            ...Array.from(player.node.handcards2?.children || []),
        ].filter(card => cards.includes(card));

        const order = dom.concat(
            cards.filter(card => !dom.includes(card))
        );

        if (!Z.blind(player)) {
            player._xd_zz_handOrder = order;
            return order;
        }

        const old = player._xd_zz_handOrder || order;

        return player._xd_zz_handOrder = old
            .filter(card => cards.includes(card))
            .concat(order.filter(card => !old.includes(card)));
    };

    Z.rememberSeats = () => {
        if (
            Z.seats.length &&
            Z.local(game.me) &&
            Z.blind(game.me)
        ) {
            return;
        }

        for (const player of [
            ...game.players,
            ...(game.dead || []),
        ]) {
            if (!Z.seats.includes(player)) {
                Z.seats.push(player);
            }
        }
    };

    Z.nature = value => {
        if (Array.isArray(value)) {
            return value.slice().sort().join("|");
        }
        return String(value || "")
            .split(/[|,]/)
            .filter(Boolean)
            .sort()
            .join("|");
    };

    // 用牌信息快照；不改写 get，也不改变实体牌的牌名、颜色或花色。
    Z.fact = (card, player) => ({
        name: get.name(card, player),
        suit: get.suit(card, player),
        color: get.color(card, player),
        number: get.number(card, player),
        nature: get.nature(card, player) || "",
    });

    Z.flip = async token => {
        const { player, material, mode } = token;
        if (!player.getCards("h").includes(material) ||
            Z.shown(material, player) !== (mode === "dream")) {
            return false;
        }
        if (mode === "awake") {
            await player.addShownCards([material], "visible_xd_zhuangzhou");
        } else {
            // 本体 hideShownCards 处理 visible_ 标签；另外清除扩展的旧明置标签。
            // 只改这张牌，不改变公共明置判断，不删除其他用途的标签。
            await player.hideShownCards([material]);
            for (const tag of Array.from(material.gaintag || [])) {
                if (tag.startsWith("visible_") ||
                    tag.startsWith("eternal_visible_") ||
                    ["xd_sijiao_tag", "xd_juemo_tag"].includes(tag)) {
                    player.removeGaintag(tag, [material]);
                }
            }
        }
        lib.xd_utils.updateShownCards(player);
        lib.xd_utils.recordCaiyanHandState(player);
        Z.refresh();
        token.flipped = player.getCards("h").includes(material) &&
            Z.shown(material, player) === (mode === "awake");
        return token.flipped;
    };

    // 插画为可选素材；没有图片时使用内置的矢量小景，不影响操作。
    Z.art = {
        base: (lib.assetURL || "") + "extension/风雨如晦（上）/image/zhuangzhou/",
        background: "dream-background.webp",
        seats: Array.from({ length: 12 }, (_, i) => "dream-seat-" + (i + 1) + ".webp"),
    };
    Z.seatLayout = new Map();
    Z.captureLayout = () => {
        if (typeof window === "undefined" || Z.blind(game.me)) return;
        Z.rememberSeats();
        const width = window.innerWidth, height = window.innerHeight;
        Z.seats.forEach((player, index) => {
            const rect = player.getBoundingClientRect?.();
            if (rect?.width > 0 && rect?.height > 0) {
                Z.seatLayout.set(player, {
                    x: Math.max(.055, Math.min(.945, (rect.left + rect.width / 2) / width)),
                    y: Math.max(.13, Math.min(.78, (rect.top + rect.height / 2) / height)),
                });
            } else if (!Z.seatLayout.has(player)) {
                const angle = 2 * Math.PI * index / Math.max(1, Z.seats.length);
                Z.seatLayout.set(player, player === game.me ? { x: .09, y: .72 } :
                    { x: .5 + .4 * Math.sin(angle), y: .36 - .22 * Math.cos(angle) });
            }
        });
    };
    Z.doodle = index => {
        const paths = [
            '<path d="M22 58Q46 26 78 54Q52 82 22 58Z"/><path d="M75 54L95 36L92 72Z"/><circle cx="35" cy="53" r="3" fill="currentColor"/><path d="M42 43Q60 8 69 23M28 84Q44 73 60 84M70 13l4-7" fill="none"/>',
            '<path d="M55 53C-3 2 9 86 52 62C10 112 88 114 59 62C112 86 110 1 55 53Z"/><path d="M55 40v40m0-36L43 30m12 14 13-17" fill="none"/>',
            '<path d="M57 18C25 0 28 50 44 53C-2 72 21 112 55 103C95 112 111 67 69 52C93 22 65 11 57 18Z"/><path d="M45 54h25M55 18q-4-18 14-14M31 79q-4 11 8 13" fill="none"/>',
            '<path d="M52 74v30m-20 0h43M53 81 32 62m21 15 22-16" fill="none"/><path d="M20 63C-5 45 20 26 31 31C27 1 76 0 74 26C108 7 112 62 87 65C67 86 39 73 20 63Z"/>',
        ];
        return '<svg viewBox="0 0 112 112" aria-hidden="true" fill="var(--wash)" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">' + paths[index % paths.length] + '</svg>';
    };
    Z.image = (parent, filename) => {
        if (!filename) return;
        const image = document.createElement("img");
        image.alt = "";
        image.draggable = false;
        image.src = Z.art.base + filename;
        image.onerror = () => image.remove();
        parent.appendChild(image);
    };
    Z.mount = () => {
        if (typeof document === "undefined" || Z.root?.isConnected) return;
        const guard = document.createElement("style");
        // 原界面从显示层隐藏，覆盖新增弹窗；不移除节点，不停止原声音/结算。
        // 新界面是 html 的独立子节点，脱离本体 body/arena 的缩放与 transform。
        guard.textContent = `
            html.xd-zz-blind { background:#eaf0f4!important; }
            html.xd-zz-blind body { opacity:0!important; }
            html.xd-zz-blind body, html.xd-zz-blind body * {
                visibility:hidden!important; pointer-events:none!important;
            }
            #xd-zz-layer { position:fixed!important; inset:0!important; margin:0!important;
                width:100vw!important; height:100vh!important; height:100dvh!important;
                max-width:none!important; max-height:none!important; padding:0!important; border:0!important;
                z-index:2147483647!important; background:transparent!important; pointer-events:none!important;
                visibility:visible!important; transform:none!important; zoom:1!important; }
        `;
        document.head.appendChild(guard);
        Z.root = document.createElement("div");
        Z.root.id = "xd-zz-layer";
        // 支持 Popover 的浏览器使用 top layer，避免游戏全屏/变换层盖住梦境。
        if (typeof Z.root.showPopover === "function") Z.root.setAttribute("popover", "manual");
        document.documentElement.appendChild(Z.root);
        Z.surface = Z.root.attachShadow({ mode: "open" });
        const style = document.createElement("style");
        style.textContent = `
            :host { --ink:#253b4c; --muted:#657783; --teal:#167c84; --wash:#d7eee5;
                font:15px/1.5 "Microsoft YaHei","Noto Sans CJK SC",sans-serif; color:var(--ink); }
            * { box-sizing:border-box; } button,select,input { font:inherit; }
            button { cursor:pointer; color:var(--ink); border:1px solid #b5c9cd; border-radius:12px;
                background:#ffffffec; padding:9px 17px; transition:background .12s,box-shadow .12s; }
            button:hover { background:#edf8f7; } button:focus-visible { outline:3px solid #48a6b4; outline-offset:3px; }
            button[disabled] { opacity:.45; cursor:default; }
            .zz-selected { box-shadow:0 0 0 3px #20949b!important; background:#dff4ef!important; }
            .zz-primary { color:white; background:#167c84; border-color:#167c84; }
            .zz-primary:hover { background:#136871; } .zz-quiet { background:transparent; }
            .zz-stage { position:absolute; inset:0; overflow:hidden; pointer-events:auto;
                background:radial-gradient(ellipse at 18% 20%,#e2e8f8 0,transparent 42%),
                radial-gradient(ellipse at 85% 20%,#d9f1e8 0,transparent 40%),linear-gradient(#f6f6f0,#e4edf2); }
            .zz-stage[hidden] { display:none; }
            .zz-background { position:absolute; inset:0; pointer-events:none; }
            .zz-background>img { width:100%; height:100%; object-fit:cover; opacity:.9; }
            .zz-landscape { position:absolute; bottom:0; width:100%; height:48%; opacity:.5; pointer-events:none; }
            .zz-moon { position:absolute; left:48%; top:20%; width:clamp(80px,12vw,170px); aspect-ratio:1;
                border-radius:50%; background:#fffaf1bb; box-shadow:0 0 90px #ffffffb0; }
            .zz-title { position:absolute; top:22px; left:28px; letter-spacing:.22em; font-weight:600; font-size:19px; }
            .zz-subtitle { font-weight:400; letter-spacing:.1em; font-size:11px; margin-top:3px; color:var(--muted); }
            .zz-poem { position:absolute; top:40%; left:50%; transform:translate(-50%,-50%); text-align:center;
                letter-spacing:.13em; color:#506876; pointer-events:none; font-size:clamp(14px,1.5vw,22px); }
            .zz-poem small { display:block; font-size:11px; letter-spacing:.2em; margin-top:9px; opacity:.7; }
            .zz-seat { position:absolute; width:clamp(68px,9vw,120px); transform:translate(-50%,-50%);
                padding:8px 6px; border:1px solid #ffffffcc; background:#fffdf3d9; border-radius:22px;
                box-shadow:0 8px 25px #39556514; text-align:center; }
            .zz-seat .zz-art { display:block; position:relative; width:100%; aspect-ratio:1; color:var(--teal); }
            .zz-art svg { width:100%; height:100%; } .zz-art>img { position:absolute; inset:0; width:100%; height:100%; object-fit:contain; object-position:center center; border-radius:12px; }
            .zz-seat:nth-of-type(3n) { --wash:#e7dff0; --teal:#826a9c; }
            .zz-seat:nth-of-type(3n+1) { --wash:#f1e6ce; --teal:#aa813d; }
            .zz-seat-index { display:block; font-size:12px; letter-spacing:.12em; }
            .zz-seat-caption { display:block; font-size:10px; color:var(--muted); margin-top:2px; white-space:nowrap; }
            .zz-handdock { position:absolute; bottom:18px; left:17%; right:3%; }
            .zz-hand { display:flex; justify-content:flex-start; align-items:flex-end; gap:8px; padding:12px 10px 8px;
                overflow-x:auto; min-height:100px; }
            .zz-hand-note { text-align:center; font-size:11px; color:var(--muted); letter-spacing:.15em; }
            .zz-actions { position:absolute; left:50%; bottom:clamp(165px,17vw,205px); transform:translateX(-50%);
                width:min(600px,80%); text-align:center; padding:13px 18px; background:#ffffffdf;
                border:1px solid #ffffff; border-radius:18px; box-shadow:0 8px 35px #29465315; }
            .zz-prompt { font-weight:600; margin-bottom:8px; } .zz-controls { display:flex; justify-content:center; flex-wrap:wrap; gap:8px; }
            .zz-summary { min-height:22px; font-size:12px; color:var(--muted); margin:5px 0 9px; }
            .zz-menu { position:absolute; left:50%; top:48%; transform:translate(-50%,-50%);
                max-height:48%; width:min(580px,78%); overflow:auto; padding:18px; background:#f9fcfcfa;
                border:1px solid #b9d0d4; border-radius:20px; box-shadow:0 15px 80px #29465324; }
            .zz-menu-title { margin-bottom:10px; font-weight:600; } .zz-menu-list { display:flex; flex-wrap:wrap; gap:8px; }
            .zz-modal-layer { position:absolute; inset:0; pointer-events:none; }
            .zz-panel { position:absolute; left:50%; top:45%; transform:translate(-50%,-50%); pointer-events:auto;
                width:min(660px,88vw); max-height:78vh; overflow:auto; padding:24px; border-radius:22px;
                border:1px solid #bdd0d4; background:#f8fbfcfa; box-shadow:0 18px 90px #183b4b33; }
            .zz-panel>div:first-child { font-size:17px; font-weight:600; } .zz-row { display:flex; flex-wrap:wrap; gap:8px; margin:14px 0; }
            @media(max-width:600px) { .zz-title{font-size:15px;top:12px;left:14px} .zz-seat{width:68px;border-radius:15px}
                .zz-seat-caption{display:none} .zz-handdock{left:2%;right:2%;bottom:10px} .zz-hand{justify-content:flex-start}
                .zz-actions{width:calc(100% - 156px);bottom:145px;padding:10px} .zz-menu{width:94%;top:37%;max-height:42%}
                button{padding:8px 11px} .zz-poem{top:39%;white-space:nowrap;font-size:13px} }
            @media(max-height:560px) { .zz-seat{width:65px} .zz-seat-caption{display:none}
                .zz-handdock{bottom:4px;left:20%}.zz-hand{min-height:85px;padding-top:8px}
                .zz-actions{bottom:110px;padding:8px;width:min(590px,76%)} .zz-menu{top:35%;max-height:55%}
                .zz-title{top:10px;font-size:14px} .zz-poem{display:none} }
        `;
        Z.surface.appendChild(style);
        Z.stage = document.createElement("div");
        Z.stage.className = "zz-stage";
        Z.stage.hidden = true;
        Z.modalLayer = document.createElement("div");
        Z.modalLayer.className = "zz-modal-layer";
        Z.surface.append(Z.stage, Z.modalLayer);
        window.addEventListener("keydown", event => {
            if (Z.ended || !Z.local(game.me) || !Z.blind(game.me) || event.key === "F12") return;
            const inside = event.composedPath().includes(Z.root);
            event.stopImmediatePropagation();
            if (!inside) event.preventDefault();
        }, true);
        window.addEventListener("resize", () => Z.refresh());
        window.visualViewport?.addEventListener("resize", () => Z.refresh());
        document.addEventListener("fullscreenchange", () => {
            if (Z.root.hidePopover && Z.root.matches(":popover-open")) Z.root.hidePopover();
            Z.refresh();
        });
    };
    Z.syncSurface = blind => {
        document.documentElement.classList.toggle("xd-zz-blind", blind);
        document.body.classList.remove("xd-zz-blind");
        const active = blind || !!Z.modal || !!Z.interaction;
        if (Z.root.showPopover) {
            if (active && !Z.root.matches(":popover-open")) Z.root.showPopover();
            else if (!active && Z.root.matches(":popover-open")) Z.root.hidePopover();
        }
        Z.stage.hidden = !blind;
    };
    // 历史梦境场景如被旧分支调用，也只使用无名杀原生卡牌节点/原生牌背；
    // 不再绘制任何“庄周专用卡背”，更不会在卡背上写“梦”。
    Z.backButton = (parent, card, index, action) => {
        let button = null;
        try {
            if (card && typeof game.createFakeCards === "function") {
                button = game.createFakeCards(card, true)[0];
            }
        } catch (e) {}
        if (!button) {
            button = ui.create.card();
            button.classList.add("infohidden", "infoflip");
        }
        button.setAttribute?.("aria-label", "手牌 " + (index + 1));
        if (action) button.addEventListener?.("click", action);
        parent.appendChild(button);
        return button;
    };
    Z.drawScene = () => {
        Z.stage.replaceChildren();
        const background = document.createElement("div");
        background.className = "zz-background";
        background.innerHTML = '<div class="zz-moon"></div><svg class="zz-landscape" viewBox="0 0 1400 300" preserveAspectRatio="none" aria-hidden="true"><path d="M0 140Q180 20 400 190T850 100T1400 150V300H0Z" fill="#d2ddd6"/><path d="M0 230Q350 20 700 210T1400 120V300H0Z" fill="#b9d5d4"/><path d="M0 255Q330 140 740 250T1400 210V300H0Z" fill="#a4c5d2"/></svg>';
        Z.image(background, Z.art.background);
        Z.stage.appendChild(background);
        const title = document.createElement("div");
        title.className = "zz-title";
        title.innerHTML = '庄周 · 梦里<div class="zz-subtitle">眼睛歇一会儿，万物自由发挥。</div>';
        Z.stage.appendChild(title);
        const poem = document.createElement("div");
        poem.className = "zz-poem";
        poem.innerHTML = '鱼在天上，蝶在水里。<small>此处风景，概不负责解释。</small>';
        Z.stage.appendChild(poem);
        const captions = ["此处有我", "鱼说今天不游了", "蝶也在做梦", "葫芦申请起飞", "树下不谈正事", "谁把云养胖了", "这位暂且是鱼", "一梦还没睡醒"];
        Z.seatButtons = new Map();
        Z.seats.forEach((player, index) => {
            const position = Z.seatLayout.get(player) || { x: .1 + .8 * index / Math.max(1, Z.seats.length - 1), y: .23 };
            const button = document.createElement("button");
            button.type = "button";
            button.className = "zz-seat";
            button.style.left = "clamp(40px, " + position.x * 100 + "%, calc(100% - 40px))";
            button.style.top = position.y * 100 + "%";
            button.setAttribute("aria-label", "座位 " + (index + 1));
            const art = document.createElement("span");
            art.className = "zz-art";
            art.innerHTML = Z.doodle(index);
            Z.image(art, Z.art.seats[index]);
            const label = document.createElement("span");
            label.className = "zz-seat-index";
            label.textContent = "座位 " + (index + 1);
            const caption = document.createElement("span");
            caption.className = "zz-seat-caption";
            caption.textContent = player === game.me ? captions[0] : captions[1 + index % (captions.length - 1)];
            button.append(art, label, caption);
            Z.stage.appendChild(button);
            Z.seatButtons.set(player, button);
        });
        const dock = document.createElement("div");
        dock.className = "zz-handdock";
        Z.handRow = document.createElement("div");
        Z.handRow.className = "zz-hand";
        Z.handButtons = new Map();
        Z.hand(game.me).forEach((card, index) => Z.handButtons.set(card, Z.backButton(Z.handRow, card, index, null)));
        const hint = document.createElement("div");
        hint.className = "zz-hand-note";
        hint.textContent = "手里的牌，凭记忆认。";
        dock.append(Z.handRow, hint);
        Z.stage.appendChild(dock);
    };
    // V2.7.15：梦境意象映射只改变本地显示，不改玩家对象、真实座次、判定与目标选择。
    // 每次从非双闭眼进入双闭眼，重新随机分配；同一段闭眼内映射稳定。
    // 这里只制作基础头像/名称遮蔽。原生战报、详情弹窗等其他信息入口留给后续专项处理。
    Z.v215ImageryPool = [
        { id: "fish", name: "乐鱼", glyph: "鱼", hue: "#5a98b4", art: "fish_lotus.webp" },
        { id: "forget_fish_trap", name: "得鱼忘筌", glyph: "筌", hue: "#9c8457", art: "forget_fish_trap.webp" },
        { id: "sea_turtle_well_frog", name: "东海之鳌拜访井底之蛙", glyph: "鳌", hue: "#6f998e", art: "sea_turtle_well_frog.webp" },
        { id: "huizi", name: "惠子", glyph: "惠", hue: "#698b96", art: "huizi_formal.webp" },
        { id: "huizi_garden", name: "惠子·论道", glyph: "惠", hue: "#698b96", art: "huizi_garden.webp", manualOnly: true },
        { id: "kunpeng", name: "鲲鹏", glyph: "鹏", hue: "#5480b6", art: "kunpeng_portrait.webp" },
        { id: "butterfly", name: "蝴蝶", glyph: "蝶", hue: "#957cb5", art: "hudie_liuguang.png" },
        { id: "turtle", name: "神龟", glyph: "龟", hue: "#5b9a94", art: "zhuang_shengui.png" },
        { id: "butcher", name: "庖丁", glyph: "丁", hue: "#8a869d", art: "paoding_funiu.png" },
        { id: "oak", name: "栎社树", glyph: "树", hue: "#67957d", art: "lishe_jushu.png" },
        { id: "mantis", name: "螳螂", glyph: "螳", hue: "#79a28d", art: "mantis_blocks_cart.png" },
        { id: "mantis_cicada_oriole", name: "螳螂捕蝉，黄雀在后", glyph: "雀", hue: "#b79054", art: "mantis_cicada_oriole.png" },
        { id: "liezi", name: "列子", glyph: "列", hue: "#7999aa", art: "liezi_yufeng.png" },
        { id: "jieyu", name: "接舆", glyph: "舆", hue: "#a78b9b", art: "jieyu_autumn.webp" },
        { id: "snail", name: "蜗牛", glyph: "蜗", hue: "#7f9e92", art: "snail_chuman_war.png" },
        { id: "shadow", name: "罔两", glyph: "罔", hue: "#718f9c", art: "wangliang_wenjing.png" },
        { id: "gourd", name: "大瓠", glyph: "瓠", hue: "#83a093", art: "zhuang_hui_dahu.png" },
        { id: "yuanchu", name: "鹓鶵", glyph: "鹓", hue: "#d7b45f", art: "yuanchu_liquan.png" },
        { id: "zhaosan", name: "朝三暮四", glyph: "狙", hue: "#a08a64", art: "zhaosan_musi.png" },
        { id: "muji", name: "呆若木鸡", glyph: "鸡", hue: "#b07a5a", art: "muji_dairuo.png" },
        { id: "handan", name: "邯郸学步", glyph: "步", hue: "#8d8f6a", art: "handan_xuebu.png" },
        { id: "dongshi", name: "东施效颦", glyph: "颦", hue: "#b4849a", art: "dongshi_xiaopin.png" },
        { id: "chenyu", name: "沉鱼落雁", glyph: "雁", hue: "#7fb0c4", art: "chenyu_luoyan.png" },
        { id: "xuefu", name: "学富五车", glyph: "车", hue: "#b99a62", art: "xuefu_wuche.png" },
        { id: "yibu", name: "亦步亦趋", glyph: "趋", hue: "#6f8a62", art: "yibu_yiqu.png" },
        { id: "junzi", name: "君子之交淡如水", glyph: "淡", hue: "#9fb4b8", art: "junzi_danshui.png" },
        { id: "xinjin", name: "薪尽火传", glyph: "薪", hue: "#c98a4a", art: "xinjin_huochuan.png" },
        { id: "tugu", name: "吐故纳新", glyph: "纳", hue: "#d9a860", art: "tugu_naxin.png" },
        { id: "qiegou", name: "窃钩者诛，窃国者侯", glyph: "钩", hue: "#8a6f5a", art: "qiegou_qieguo.png" },
        { id: "tianlai", name: "天籁", glyph: "籁", hue: "#7fa3b8", art: "tianlai_tingtao.png" },
        { id: "hongmeng", name: "鸿蒙", glyph: "鸿", hue: "#a69bb8", art: "hongmeng_yunjiang.png" },
        { id: "zuowang", name: "坐忘", glyph: "忘", hue: "#8fa68a", art: "zuowang_yunhai.png" },
        { id: "zhili", name: "支离", glyph: "离", hue: "#9a8f7c", art: "zhili_posui.png" },
        { id: "xiangru", name: "相濡以沫", glyph: "沫", hue: "#6a9cad", art: "xiangru_ximo.png" },
        { id: "wangyang", name: "望洋兴叹", glyph: "河", hue: "#5f8fae", art: "wangyang_xingtan.png" },
        { id: "xiachong", name: "夏虫语冰", glyph: "冰", hue: "#8fb5c4", art: "xiachong_yubing.png" },
        { id: "yuezu", name: "越俎代庖", glyph: "俎", hue: "#a8865c", art: "yuezu_daipao.png" },
        { id: "tulong", name: "屠龙之技", glyph: "龙", hue: "#7a8a6e", art: "tulong_zhiji.png" },
        { id: "tanli", name: "探骊得珠", glyph: "珠", hue: "#4f7f99", art: "tanli_dezhu.png" },
        { id: "duanhe", name: "断鹤续凫", glyph: "鹤", hue: "#9aa6a0", art: "duanhe_xufu.png" },
        { id: "yanshu", name: "偃鼠饮河", glyph: "鼠", hue: "#8a7a64", art: "yanshu_yinhe.png" },
        { id: "baiju", name: "白驹过隙", glyph: "驹", hue: "#b9b2a0", art: "baiju_guoxi.png" },
        { id: "zhuojin", name: "捉襟见肘", glyph: "襟", hue: "#94806a", art: "zhuojin_jianzhou.png" },
        { id: "hezhe", name: "涸辙之鲋", glyph: "鲋", hue: "#9a8c6e", art: "hezhe_fuyu.png" },
        // 经游戏内变化才能看到的卡画统一置底，避免一打开“换”便泄露后续故事。
        { id: "fish_splash", name: "不乐鱼", glyph: "鱼", hue: "#5a98b4", art: "fish_splash.webp", manualOnly: true },
        { id: "fish_bridge", name: "濠梁观鱼", glyph: "鱼", hue: "#5a98b4", art: "fish_bridge.webp", manualOnly: true },
        { id: "yuanchu_spring", name: "梧桐醴泉", glyph: "泉", hue: "#d7b45f", art: "wutong_liquan.png", manualOnly: true },
        // 仍可手动选到，且不进入随机初始角色形象池。
        { id: "grilled_fish", name: "烤鱼", glyph: "烤", hue: "#ab725b", art: "grilled_fish.webp", manualOnly: true },
        { id: "burnt_fish", name: "烤糊的鱼", glyph: "糊", hue: "#765549", art: "burnt_fish.webp", manualOnly: true },
        { id: "huizi_cat", name: "惠子展示虎威", glyph: "猫", hue: "#698b96", art: "huizi_cat_formal.webp", manualOnly: true },
        { id: "huizi_cat_close", name: "惠子·虎威", glyph: "猫", hue: "#698b96", art: "huizi_cat_garden.webp", manualOnly: true },
        // 庄惠削灰组只由手动选择或无伤往来开启，不参与初始随机。
        { id: "zh_cut_dust", name: "庄子削灰", glyph: "削", hue: "#c49b74", art: "zhuangzi_cut_dust.png", manualOnly: true },
        { id: "hz_return_cut", name: "惠子扯平", glyph: "斧", hue: "#c49b74", art: "huizi_return_cut.png", manualOnly: true },
        { id: "hz_two_axes", name: "惠子展示技术", glyph: "斧", hue: "#d7a45f", art: "huizi_two_axes.png", manualOnly: true },
        { id: "zhuang_hui_boat", name: "庄惠瓠舟", glyph: "瓠", hue: "#8bbab0", art: "zhuang_hui_boat_portrait.webp", manualOnly: true },
    ];
    // 未标记 manualOnly 的条目参与普通随机；带 manualOnly 的变体仅用于手动改标。
    // 新增场景形象保留独立条目，不改变鱼／惠子等已有变体的随机规则。
    Z.v219RandomPool = Z.v215ImageryPool.filter(item => !item.manualOnly);
    Z.v233OwnButterflyChoice = null;
    Z.v233OwnButterflyNodes = new Set();
    Z.v233OwnButterflyOriginal = new WeakMap();
    // V2.7.38：只改下方五个数字就能调整入梦时庄周自己的卡画权重。
    // 权重可以为 0（不抽中），也不必凑成 100，系统会自动按总和换算概率。
    // 不要改左边的字段名；修改数字后，保存 extension.js 并重启游戏即可生效。
    Z.v238OwnPortraitWeights = {
        original: 50,                 // 保持庄周原武将图
        zhuangzhou_mengdie: 20,       // 庄周梦蝶
        diemeng_zhuangzhou: 20,       // 蝶梦庄周
        dreaming_butterfly: 5,       // 能做梦的蝶
        young_zhuangzhou_dreaming: 5 // 做梦的年轻庄周
    };
    Z.v238OwnPortraitPool = [
        { art: "", weightKey: "original" },
        { art: "zhuangzhou_mengdie.png", weightKey: "zhuangzhou_mengdie" },
        { art: "diemeng_zhuangzhou.png", weightKey: "diemeng_zhuangzhou" },
        { art: "dreaming_butterfly.png", weightKey: "dreaming_butterfly" },
        { art: "young_zhuangzhou_dreaming.png", weightKey: "young_zhuangzhou_dreaming" },
    ];
    // 背景以主题组为单位抽签，与一组中有多少张壁纸无关。
    // 这里同样只改数字即可调权重；写 0 表示这一组不参与普通随机。
    Z.v241DreamWallpaperWeights = {
        default_landscape: 1,
        yuanchu_triptych: 1,
        kunpeng_sequence: 1,
        zhuang_hui_boat: 1,
        diaoyu_pushui: 1,
        mantis_cart: 1,
        baiju_guoxi: 1,
        lishe_shu: 1,
    };
    // 鲲鹏组播放顺序：只须调整下列文件名的位置；新增图片放入 assets/zhuangzhou/
    // 并在下列数组增加一行即可。每抽中此组播放下一张，播放到末尾后从第一张循环。
    Z.kunpengWallpaperOrder = [
        "kunpeng_01_storm.webp",      // 借风暴出海
        "kunpeng_02_sky.webp",        // 升空、俯瞰北冥南冥
        "kunpeng_03_south_sea.webp",  // 抵达南冥
        "kunpeng_04_overlook.webp",   // 鲲鹏视角俯瞰南冥
        "kunpeng_05_dive.webp",       // 撞入海面
        "kunpeng_06_underwater.webp", // 进入水下
    ];
    Z.v241DreamWallpaperPool = [
        { id: "default_landscape", art: "", weightKey: "default_landscape" },
        { id: "yuanchu_triptych", weightKey: "yuanchu_triptych" },
        { id: "kunpeng_sequence", weightKey: "kunpeng_sequence" },
        { id: "zhuang_hui_boat", art: "zhuang_hui_boat_wallpaper.webp", weightKey: "zhuang_hui_boat" },
        { id: "diaoyu_pushui", name: "钓于濮水", art: "diaoyu_pushui.png", weightKey: "diaoyu_pushui" },
        { id: "mantis_cart", name: "螳臂挡车", art: "mantis_cart_wallpaper.png", weightKey: "mantis_cart" },
        { id: "baiju_guoxi", name: "白驹过隙", art: "baiju_guoxi_wallpaper.png", weightKey: "baiju_guoxi" },
        { id: "lishe_shu", name: "栎社树", art: "lishe_shu_wallpaper.png", weightKey: "lishe_shu" },
    ];
    Z.v241DreamWallpaperState = {
        current: null,
        yuanchuPendingFinal: false,
        yuanchuFinalUnlocked: false,
        yuanchuPendingMoon: false,
        yuanchuMoonUnlocked: false,
        kunpengNext: 0,  // 本局下次抽中鲲鹏组时应播哪张（从零开始）
    };
    Z.v241DreamWallpaperSaved = new WeakMap();
    Z.v241DreamWallpaperAppliedNodes = new Set();
    // 只记住已真正绘制的背景；被主题重写时仍能在下一次同步中恢复。
    Z.v241WallpaperRendered = new WeakMap();
    Z.v241WallpaperActive = () => !!(Z.v2proto && Z.local(game.me) && Z.blind(game.me) && Z.alive(game.me) && !Z.ended);
    Z.v241WallpaperTargetNodes = () => {
        const nodes = [];
        const push = node => {
            if (!node || nodes.includes(node)) return;
            nodes.push(node);
        };
        try { push(ui?.background); } catch (e) {}
        try { push(document.querySelector?.("#background")); } catch (e) {}
        try { push(document.querySelector?.(".background")); } catch (e) {}
        return nodes.filter(Boolean);
    };
    Z.v241WallpaperArtForChoice = choice => {
        if (!choice) return "";
        if (choice.group === "yuanchu_triptych") {
            if (choice.stage === "moon") return "yuanchu_bg_moon.png";
            if (choice.stage === "final") return "yuanchu_bg_departed.png";
            if (choice.stage === "standing") return "yuanchu_bg_standing.png";
            return "yuanchu_bg_drinking.png";
        }
        if (choice.group === "kunpeng_sequence") return choice.art || "";
        if (choice.group === "zhuang_hui_boat") return "zhuang_hui_boat_wallpaper.webp";
        if (choice.group === "diaoyu_pushui") return "diaoyu_pushui.png";
        if (choice.group === "mantis_cart") return "mantis_cart_wallpaper.png";
        if (choice.group === "baiju_guoxi") return "baiju_guoxi_wallpaper.png";
        if (choice.group === "lishe_shu") return "lishe_shu_wallpaper.png";
        return "";
    };
    Z.v241ClearDreamWallpaper = () => {
        for (const node of Array.from(Z.v241DreamWallpaperAppliedNodes)) {
            const old = Z.v241DreamWallpaperSaved.get(node);
            if (!old) continue;
            node.style.backgroundImage = old.backgroundImage;
            node.style.backgroundSize = old.backgroundSize;
            node.style.backgroundPosition = old.backgroundPosition;
            node.style.backgroundRepeat = old.backgroundRepeat;
            node.style.backgroundColor = old.backgroundColor;
            node.style.transition = old.transition;
        }
        Z.v241DreamWallpaperAppliedNodes.clear();
        Z.v241WallpaperRendered = new WeakMap();
    };
    Z.v241DreamWallpaperRenderedMark = (node, url) => {
        Z.v241WallpaperRendered.set(node, { url, css: node.style.backgroundImage });
    };
    Z.v241ApplyDreamWallpaper = choice => {
        const art = Z.v241WallpaperArtForChoice(choice);
        if (!art) {
            Z.v241ClearDreamWallpaper();
            return;
        }
        const url = Z.v219ArtUrl(art);
        for (const node of Z.v241WallpaperTargetNodes()) {
            const rendered = Z.v241WallpaperRendered.get(node);
            if (rendered?.url === url && rendered.css === node.style.backgroundImage) continue;
            if (!Z.v241DreamWallpaperSaved.has(node)) {
                Z.v241DreamWallpaperSaved.set(node, {
                    backgroundImage: node.style.backgroundImage || "",
                    backgroundSize: node.style.backgroundSize || "",
                    backgroundPosition: node.style.backgroundPosition || "",
                    backgroundRepeat: node.style.backgroundRepeat || "",
                    backgroundColor: node.style.backgroundColor || "",
                    transition: node.style.transition || "",
                });
            }
            const fade = "background-image .28s ease, background-position .28s ease";
            node.style.transition = String(node.style.transition || "").includes(fade)
                ? node.style.transition
                : [node.style.transition, fade].filter(Boolean).join(", ");
            node.style.backgroundImage = 'url("' + url + '")';
            node.style.backgroundSize = 'cover';
            node.style.backgroundPosition = 'center center';
            node.style.backgroundRepeat = 'no-repeat';
            node.style.backgroundColor = '#e7edf1';
            Z.v241DreamWallpaperRenderedMark?.(node, url);
            Z.v241DreamWallpaperAppliedNodes.add(node);
        }
    };
    Z.v241ChooseDreamWallpaper = () => {
        const state = Z.v241DreamWallpaperState;
        if (state.yuanchuPendingMoon) {
            state.yuanchuPendingMoon = false;
            state.yuanchuMoonUnlocked = true;
            return { group: "yuanchu_triptych", stage: "moon" };
        }
        if (state.yuanchuPendingFinal) {
            state.yuanchuPendingFinal = false;
            state.yuanchuFinalUnlocked = true;
            state.yuanchuPendingMoon = true;
            return { group: "yuanchu_triptych", stage: "final" };
        }
        // 鲲鹏组已开播但未播完：继续下一张，不重新抽签；播完后才回到随机。
        if (state.kunpengNext > 0 && Z.kunpengWallpaperOrder.length) {
            const order = Z.kunpengWallpaperOrder;
            const index = state.kunpengNext % order.length;
            state.kunpengNext = (index + 1) % order.length;
            return { group: "kunpeng_sequence", stage: index, art: order[index] };
        }
        const weighted = Z.v241DreamWallpaperPool.map(item => {
            const value = Number(Z.v241DreamWallpaperWeights[item.weightKey]);
            return { item, weight: Number.isFinite(value) && value > 0 ? value : 0 };
        }).filter(entry => entry.weight > 0);
        const total = weighted.reduce((sum, entry) => sum + entry.weight, 0);
        if (!(total > 0)) return { group: "default_landscape", stage: "base" };
        let roll = Math.random() * total;
        let chosen = weighted[weighted.length - 1].item;
        for (const entry of weighted) {
            if (roll < entry.weight) {
                chosen = entry.item;
                break;
            }
            roll -= entry.weight;
        }
        if (chosen.id === "yuanchu_triptych") {
            return {
                group: "yuanchu_triptych",
                stage: state.yuanchuMoonUnlocked ? "moon" : "drinking",
            };
        }
        if (chosen.id === "kunpeng_sequence" && Z.kunpengWallpaperOrder.length) {
            const order = Z.kunpengWallpaperOrder;
            const index = state.kunpengNext % order.length;
            state.kunpengNext = (index + 1) % order.length;
            return { group: "kunpeng_sequence", stage: index, art: order[index] };
        }
        if (chosen.id === "zhuang_hui_boat") {
            return { group: "zhuang_hui_boat", stage: "base" };
        }
        if (chosen.id === "diaoyu_pushui") {
            return { group: "diaoyu_pushui", stage: "base", art: "diaoyu_pushui.png" };
        }
        if (chosen.id === "mantis_cart") {
            return { group: "mantis_cart", stage: "base", art: "mantis_cart_wallpaper.png" };
        }
        if (chosen.id === "baiju_guoxi") {
            return { group: "baiju_guoxi", stage: "base", art: "baiju_guoxi_wallpaper.png" };
        }
        if (chosen.id === "lishe_shu") {
            return { group: "lishe_shu", stage: "base", art: "lishe_shu_wallpaper.png" };
        }
        return { group: "default_landscape", stage: "base" };
    };
    Z.v241BeginDreamWallpaper = () => {
        if (!Z.v241WallpaperActive()) {
            Z.v241DreamWallpaperState.current = null;
            Z.v241ClearDreamWallpaper();
            return;
        }
        const choice = Z.v241ChooseDreamWallpaper();
        Z.v241DreamWallpaperState.current = choice;
        Z.v241ApplyDreamWallpaper(choice);
    };
    Z.v241SyncDreamWallpaper = () => {
        if (!Z.v241WallpaperActive()) {
            Z.v241ClearDreamWallpaper();
            return;
        }
        const current = Z.v241DreamWallpaperState.current;
        if (!current) {
            Z.v241BeginDreamWallpaper();
            return;
        }
        Z.v241ApplyDreamWallpaper(current);
    };
    Z.v241OnZhuangzhouUseOnOthers = () => {
        const state = Z.v241DreamWallpaperState;
        const current = state.current;
        if (!current || current.group !== "yuanchu_triptych" || current.stage !== "drinking") return false;
        current.stage = "standing";
        state.yuanchuPendingFinal = true;
        Z.v241ApplyDreamWallpaper(current);
        return true;
    };
    Z.v241StopDreamWallpaper = () => {
        Z.v241DreamWallpaperState.current = null;
        Z.v241ClearDreamWallpaper();
    };
    // 只在控制台检查所选图片的路径，不额外泄露到梦中战报或弹出提示。
    Z.v236CheckedButterflyArt = new Set();
    Z.v236CheckButterflyAsset = art => {
        if (!art || Z.v236CheckedButterflyArt.has(art) || typeof Image === "undefined") return;
        Z.v236CheckedButterflyArt.add(art);
        const probe = new Image();
        probe.onerror = () => {
            try { console.warn("[庄周梦蝶] 卡画加载失败，请检查 assets/zhuangzhou/" + art); } catch (e) {}
        };
        probe.src = Z.v219ArtUrl(art);
    };
    Z.v233ChooseOwnButterfly = () => {
        // 只在新一段闭眼开始时调用一次；本段闭眼内选择不变。
        const pool = Z.v238OwnPortraitPool.map(item => {
            const number = Number(Z.v238OwnPortraitWeights[item.weightKey]);
            return { art: item.art, weight: Number.isFinite(number) && number > 0 ? number : 0 };
        });
        const total = pool.reduce((sum, item) => sum + item.weight, 0);
        if (!(total > 0)) return ""; // 五项全为零时，保留原画。
        let roll = Math.random() * total;
        let chosen = "";
        for (const item of pool) {
            if (!item.weight) continue;
            if (roll < item.weight) {
                chosen = item.art;
                break;
            }
            roll -= item.weight;
        }
        try { console.debug("[庄周梦蝶] 本次闭眼卡画：", chosen || "原庄周卡画"); } catch (e) {}
        Z.v236CheckButterflyAsset(chosen);
        return chosen;
    };
    Z.v233EachOwnAvatarNode = callback => {
        const nodes = [
            game.me?.node?.avatar,
            game.me?.node?.avatar2,
            game.me?.querySelector?.(".avatar"),
            game.me?.querySelector?.(".avatar2"),
        ].filter(Boolean);
        const seen = new Set();
        for (const node of nodes) {
            if (!node || seen.has(node)) continue;
            seen.add(node);
            callback(node);
        }
    };
    Z.v233ApplyOwnButterfly = art => {
        if (!art || typeof document === "undefined") return;
        const url = Z.v219ArtUrl(art);
        Z.v233EachOwnAvatarNode(node => {
            const applied = node._xd_zz_butterflyRendered;
            if (applied?.url === url && applied.css === node.style.backgroundImage &&
                node.classList?.contains?.('xd-zz-v233-own-butterfly')) return;
            if (!Z.v233OwnButterflyOriginal.has(node)) {
                Z.v233OwnButterflyOriginal.set(node, {
                    backgroundImage: node.style.backgroundImage || "",
                    backgroundSize: node.style.backgroundSize || "",
                    backgroundPosition: node.style.backgroundPosition || "",
                    backgroundRepeat: node.style.backgroundRepeat || "",
                });
            }
            node.style.backgroundImage = 'url("' + url + '")';
            node.style.backgroundSize = 'cover';
            node.style.backgroundPosition = 'center center';
            node.style.backgroundRepeat = 'no-repeat';
            node.classList?.add?.('xd-zz-v233-own-butterfly');
            node._xd_zz_butterflyRendered = { url, css: node.style.backgroundImage };
            Z.v233OwnButterflyNodes.add(node);
        });
    };
    Z.v233RestoreOwnButterfly = () => {
        for (const node of Array.from(Z.v233OwnButterflyNodes)) {
            const old = Z.v233OwnButterflyOriginal.get(node);
            if (old) {
                node.style.backgroundImage = old.backgroundImage;
                node.style.backgroundSize = old.backgroundSize;
                node.style.backgroundPosition = old.backgroundPosition;
                node.style.backgroundRepeat = old.backgroundRepeat;
            }
            node.classList?.remove?.('xd-zz-v233-own-butterfly');
            delete node._xd_zz_butterflyRendered;
        }
        Z.v233OwnButterflyNodes.clear();
        Z.v233OwnButterflyChoice = null;
    };
    Z.v233SyncOwnButterfly = () => {
        const active = !!(Z.v2proto && Z.local(game.me) && Z.blind(game.me) && Z.alive(game.me) && !Z.ended);
        if (!active) {
            Z.v233RestoreOwnButterfly();
            return;
        }
        if (Z.v233OwnButterflyChoice == null) Z.v233OwnButterflyChoice = Z.v233ChooseOwnButterfly();
        if (!Z.v233OwnButterflyChoice) return;
        Z.v233ApplyOwnButterfly(Z.v233OwnButterflyChoice);
    };
    Z.v219ArtUrl = art => art
        ? ((typeof lib !== "undefined" && lib.assetURL) || "") +
            "extension/风雨如晦（上）/assets/zhuangzhou/" + art
        : "";
    // 所有图片都仅参与本地表现层，加载失败则回退到原来的汉字意象。
    Z.v219PlaySwapFx = frame => {
        if (!frame?.classList) return;
        frame.classList.remove("xd-zz-v219-switchfx");
        try { void frame.offsetWidth; } catch (e) {}
        frame.classList.add("xd-zz-v219-switchfx");
        if (frame._xd_zz_fx_timer) clearTimeout(frame._xd_zz_fx_timer);
        frame._xd_zz_fx_timer = setTimeout(() => {
            try { frame.classList.remove("xd-zz-v219-switchfx"); } catch (e) {}
        }, 560);
    };
    Z.v219SyncArt = (frame, img, image) => {
        if (!img) return;
        const art = image?.art || "";
        if (img._xd_zz_art === art) return;
        // V2.7.37: the menu's 20+ preview images must NOT all animate on open.
        // Only changing an already-displayed battlefield veil earns V34's full
        // blur + scale + light sweep. New battlefield veils get the entry-mist
        // animation independently, exactly once when entering a dream.
        const previouslyAssigned = img._xd_zz_art !== undefined;
        const onBattlefield = !!frame?.classList?.contains("xd-zz-v215-veil");
        const animateSwap = onBattlefield && previouslyAssigned;
        img._xd_zz_art = art;
        img.classList.remove("xd-zz-v219-swapping");
        if (animateSwap) {
            img.classList.add("xd-zz-v219-swapping");
            Z.v219PlaySwapFx(frame);
        }
        if (!art) {
            img.hidden = true;
            img.removeAttribute?.("src");
            img.classList.remove("xd-zz-v219-swapping");
            frame.classList.remove("xd-zz-v219-has-art");
            return;
        }
        img.hidden = false;
        frame.classList.add("xd-zz-v219-has-art");
        img.onload = () => {
            if (img._xd_zz_art !== art) return;
            img.classList.remove("xd-zz-v219-swapping");
        };
        img.onerror = () => {
            if (img._xd_zz_art !== art) return;
            img.hidden = true;
            img.classList.remove("xd-zz-v219-swapping");
            frame.classList.remove("xd-zz-v219-has-art");
        };
        img.src = Z.v219ArtUrl(art);
    };
    Z.v219MakeArt = (frame, image) => {
        const img = document.createElement("img");
        img.className = "xd-zz-v219-art";
        img.alt = "";
        img.setAttribute("aria-hidden", "true");
        img.decoding = "async";
        // Only the chooser's scrolled list uses lazy loading. Current-preview
        // and battlefield images remain eager, with no additional animation.
        if (frame?.classList?.contains("xd-zz-v216-choice-thumb")) img.loading = "lazy";
        Z.v219SyncArt(frame, img, image);
        return img;
    };
    Z.v215ImageryMap = new Map();
    // 只属于本局庄周自己的观察笔记。随机意象每次重新抽取；手工标记跨闭眼保留。
    Z.v215ManualImagery = new Map();
    // 双图共用 grilled_fish 逻辑状态；只在变为烤鱼或手动改标时决定卡画。
    Z.v287GrilledArts = new Map();
    Z.v287GrilledVariants = [
        { art: "grilled_fish.webp", choiceName: "烤鱼·一" },
        { art: "grilled_fish_02.png", choiceName: "烤鱼·山寺盛宴" },
    ];
    Z.v287GrilledImage = (player, image, randomize = false, art) => {
        if (image?.id !== "grilled_fish") return image;
        if (randomize) {
            art = Z.v287GrilledVariants[Math.floor(Math.random() * Z.v287GrilledVariants.length)].art;
        } else {
            art ||= Z.v287GrilledArts.get(player) || image.art;
        }
        if (!Z.v287GrilledVariants.some(variant => variant.art === art)) return image;
        Z.v287GrilledArts.set(player, art);
        return { ...image, art };
    };
    Z.v287ChoiceImages = () => Z.v215ImageryPool.flatMap(image =>
        image.id === "grilled_fish"
            ? Z.v287GrilledVariants.map(variant => ({ ...image, ...variant }))
            : [image]
    );
    Z.v215Chooser = null;
    Z.v215PreviousMap = new Map();
    Z.v215Overlays = new Map();
    Z.v215ImageryActive = false;
    Z.v215Shuffle = values => {
        const result = values.slice();
        for (let i = result.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [result[i], result[j]] = [result[j], result[i]];
        }
        return result;
    };
    Z.v215CloseChooser = () => {
        if (!Z.v215Chooser) return;
        try { Z.v215Chooser.remove(); } catch (e) {}
        Z.v215Chooser = null;
    };

    // V2.8.3：闭眼时原生头像的“双击查看武将详情”会直接泄露真实武将信息。
    // 保留第一次点击的原生选目标行为；500ms 内第二次点击只打开梦中“角色形象”故事，
    // 不再让 ui.click.avatar/avatar2 进入 charactercard()。死者的梦境外壳也使用同一规则。
    Z.v283StoryHost = null;
    Z.v283StoryKeyHandler = null;
    Z.v283LastDreamTap = new WeakMap();
    Z.v283DreamIntroGuard = null;
    // V2.8.6：介绍正文只摘《庄子》原文，篇名和梦境改写说明另放在出处栏。
    // 2026-10-12 逐字依中國哲學書電子化計劃（ctext.org）《莊子》原文，用字、標點皆從之；節錄處以「……」標出。
    // 同源形象共用摘录；删节显式标出，绝不将梦境新增情节写成古籍原文。
    const v286Excerpts = {
        fish: {
            chapter: "秋水",
            text: "莊子與惠子遊於濠梁之上。莊子曰：「儵魚出遊從容，是魚樂也。」惠子曰：「子非魚，安知魚之樂？」莊子曰：「子非我，安知我不知魚之樂？」惠子曰：「我非子，固不知子矣；子固非魚也，子之不知魚之樂全矣。」莊子曰：「請循其本。子曰『汝安知魚樂』云者，既已知吾知之而問我，我知之濠上也。」"
        },
        trap: {
            chapter: "外物",
            text: "荃者所以在魚，得魚而忘荃。"
        },
        seaTurtle: {
            chapter: "秋水",
            text: "東海之鱉左足未入，而右膝已縶矣。於是逡巡而卻，告之海曰：『夫千里之遠，不足以舉其大；千仞之高，不足以極其深。禹之時，十年九潦，而水弗為加益；湯之時，八年七旱，而崖不為加損。夫不為頃久推移，不以多少進退者，此亦東海之大樂也。』於是埳井之鼃聞之，適適然驚，規規然自失也。"
        },
        huizi: {
            chapter: "徐無鬼",
            text: "莊子曰：「射者非前期而中，謂之善射，天下皆羿也，可乎？」惠子曰：「可。」莊子曰：「天下非有公是也，而各是其所是，天下皆堯也，可乎？」惠子曰：「可。」"
        },
        debate: {
            chapter: "外物",
            text: "惠子謂莊子曰：「子言無用。」莊子曰：「知無用而始可與言用矣。夫地非不廣且大也，人之所用容足耳。然則廁足而墊之，致黃泉，人尚有用乎？」惠子曰：「無用。」莊子曰：「然則無用之為用也亦明矣。」"
        },
        kunpeng: {
            chapter: "逍遙遊",
            text: "北冥有魚，其名為鯤。鯤之大，不知其幾千里也。化而為鳥，其名為鵬。鵬之背，不知其幾千里也；怒而飛，其翼若垂天之雲。是鳥也，海運則將徙於南冥。南冥者，天池也。齊諧者，志怪者也。諧之言曰：「鵬之徙於南冥也，水擊三千里，摶扶搖而上者九萬里，去以六月息者也。」"
        },
        butterfly: {
            chapter: "齊物論",
            text: "昔者莊周夢為胡蝶，栩栩然胡蝶也，自喻適志與！不知周也。俄然覺，則蘧蘧然周也。不知周之夢為胡蝶與，胡蝶之夢為周與？周與胡蝶，則必有分矣。此之謂物化。"
        },
        turtle: {
            chapter: "秋水",
            text: "莊子釣於濮水，楚王使大夫二人往先焉，曰：「願以境內累矣！」莊子持竿不顧，曰：「吾聞楚有神龜，死已三千歲矣，王巾笥而藏之廟堂之上。此龜者，寧其死為留骨而貴乎，寧其生而曳尾於塗中乎？」二大夫曰：「寧生而曳尾塗中。」莊子曰：「往矣！吾將曳尾於塗中。」"
        },
        butcher: {
            chapter: "養生主",
            text: "庖丁為文惠君解牛，手之所觸，肩之所倚，足之所履，膝之所踦，砉然嚮然，奏刀騞然，莫不中音。合於《桑林》之舞，乃中《經首》之會。文惠君曰：「譆！善哉！技蓋至此乎？」庖丁釋刀對曰：「臣之所好者道也，進乎技矣。始臣之解牛之時，所見无非牛者。三年之後，未嘗見全牛也。方今之時，臣以神遇，而不以目視，官知止而神欲行。依乎天理，批大郤，導大窾，因其固然。技經肯綮之未嘗，而況大軱乎！良庖歲更刀，割也；族庖月更刀，折也。今臣之刀十九年矣，所解數千牛矣，而刀刃若新發於硎。彼節者有間，而刀刃者无厚，以无厚入有間，恢恢乎其於遊刃必有餘地矣，是以十九年而刀刃若新發於硎。雖然，每至於族，吾見其難為，怵然為戒，視為止，行為遲。動刀甚微，謋然已解，如土委地。提刀而立，為之四顧，為之躊躇滿志，善刀而藏之。」文惠君曰：「善哉！吾聞庖丁之言，得養生焉。」"
        },
        oak: {
            chapter: "人間世",
            text: "匠石之齊，至乎曲轅，見櫟社樹。其大蔽數千牛，絜之百圍，其高臨山十仞而後有枝，其可以為舟者旁十數。觀者如市，匠伯不顧，遂行不輟。弟子厭觀之，走及匠石，曰：「自吾執斧斤以隨夫子，未嘗見材如此其美也。先生不肯視，行不輟，何邪？」曰：「已矣，勿言之矣！散木也，以為舟則沈，以為棺槨則速腐，以為器則速毀，以為門戶則液樠，以為柱則蠹。是不材之木也，無所可用，故能若是之壽。」"
        },
        mantis: {
            chapter: "人間世",
            text: "汝不知夫螳蜋乎？怒其臂以當車轍，不知其不勝任也，是其才之美者也。戒之慎之！積伐而美者以犯之，幾矣。"
        },
        mantisCicadaOriole: {
            chapter: "山木",
            text: "莊周遊乎雕陵之樊，睹一異鵲自南方來者，翼廣七尺，目大運寸，感周之顙而集於栗林。莊周曰：「此何鳥哉？翼殷不逝，目大不覩。」蹇裳躩步，執彈而留之。睹一蟬方得美蔭而忘其身；螳蜋執翳而搏之，見得而忘其形；異鵲從而利之，見利而忘其真。莊周怵然曰：「噫！物固相累，二類相召也。」捐彈而反走，虞人逐而誶之。"
        },
        quail: {
            chapter: "逍遙遊",
            text: "斥鴳笑之曰：「彼且奚適也？我騰躍而上，不過數仞而下，翱翔蓬蒿之間，此亦飛之至也。而彼且奚適也？」此小大之辯也。"
        },
        liezi: {
            chapter: "逍遙遊",
            text: "夫列子御風而行，泠然善也，旬有五日而後反。彼於致福者，未數數然也。此雖免乎行，猶有所待者也。"
        },
        jieyu: {
            chapter: "人間世",
            text: "孔子適楚，楚狂接輿遊其門曰：「鳳兮鳳兮，何如德之衰也！來世不可待，往世不可追也。天下有道，聖人成焉；天下無道，聖人生焉。方今之時，僅免刑焉。福輕乎羽，莫之知載；禍重乎地，莫之知避。已乎已乎，臨人以德！殆乎殆乎，畫地而趨！迷陽迷陽，無傷吾行！吾行卻曲，無傷吾足！」"
        },
        snail: {
            chapter: "則陽",
            text: "惠子聞之而見戴晉人。戴晉人曰：「有所謂蝸者，君知之乎？」曰：「然。」「有國於蝸之左角者曰觸氏，有國於蝸之右角者曰蠻氏，時相與爭地而戰，伏尸數萬，逐北旬有五日而後反。」"
        },
        shadow: {
            chapter: "齊物論",
            text: "罔兩問景曰：「曩子行，今子止，曩子坐，今子起，何其無特操與？」景曰：「吾有待而然者邪！吾所待又有待而然者邪！吾待蛇蚹、蜩翼邪！惡識所以然？惡識所以不然？」"
        },
        gourd: {
            chapter: "逍遙遊",
            text: "惠子謂莊子曰：「魏王貽我大瓠之種，我樹之成而實五石，以盛水漿，其堅不能自舉也。剖之以為瓢，則瓠落無所容。非不呺然大也，吾為其無用而掊之。」莊子曰：「夫子固拙於用大矣。\n……\n今子有五石之瓠，何不慮以為大樽而浮乎江湖，而憂其瓠落無所容？則夫子猶有蓬之心也夫！」"
        },
        yuanchu: {
            chapter: "秋水",
            text: "惠子相梁，莊子往見之。或謂惠子曰：「莊子來，欲代子相。」於是惠子恐，搜於國中三日三夜。莊子往見之，曰：「南方有鳥，其名為鵷鶵，子知之乎？夫鵷鶵發於南海而飛於北海，非梧桐不止，非練實不食，非醴泉不飲。於是鴟得腐鼠，鵷鶵過之，仰而視之曰：『嚇！』今子欲以子之梁國而嚇我邪？」"
        },
        spring: {
            chapter: "秋水",
            text: "夫鵷鶵發於南海而飛於北海，非梧桐不止，非練實不食，非醴泉不飲。"
        },
        zhaosan: {
            chapter: "齊物論",
            text: "勞神明為一，而不知其同也，謂之朝三。何謂朝三？曰狙公賦芧，曰：「朝三而莫四。」眾狙皆怒。曰：「然則朝四而莫三。」眾狙皆悅。名實未虧，而喜怒為用，亦因是也。"
        },
        muji: {
            chapter: "達生",
            text: "紀渻子為王養鬥雞。十日而問：「雞已乎？」曰：「未也。方虛憍而恃氣。」十日又問。曰：「未也。猶應嚮景。」十日又問。曰：「未也。猶疾視而盛氣。」十日又問。曰：「幾矣。雞雖有鳴者，已無變矣，望之似木雞矣，其德全矣，異雞無敢應者，反走矣。」"
        },
        handan: {
            chapter: "秋水",
            text: "且子獨不聞壽陵餘子之學行於邯鄲與？未得國能，又失其故行矣，直匍匐而歸耳。"
        },
        dongshi: {
            chapter: "天運",
            text: "故西施病心而矉其里，其里之醜人見而美之，歸亦捧心而矉其里。其里之富人見之，堅閉門而不出；貧人見之，挈妻子而去之走。彼知矉美而不知矉之所以美。"
        },
        xiangru: {
            chapter: "大宗師",
            text: "泉涸，魚相與處於陸，相呴以溼，相濡以沫，不如相忘於江湖。"
        },
        wangyang: {
            chapter: "秋水",
            text: "秋水時至，百川灌河，涇流之大，兩涘渚崖之間，不辯牛馬。於是焉河伯欣然自喜，以天下之美為盡在己。順流而東行，至於北海，東面而視，不見水端，於是焉河伯始旋其面目，望洋向若而歎，曰：「野語有之曰『聞道百，以為莫己若』者，我之謂也。」"
        },
        xiachong: {
            chapter: "秋水",
            text: "北海若曰：「井蛙不可以語於海者，拘於虛也；夏蟲不可以語於冰者，篤於時也；曲士不可以語於道者，束於教也。」"
        },
        yuezu: {
            chapter: "逍遙遊",
            text: "庖人雖不治庖，尸祝不越樽俎而代之矣。"
        },
        tulong: {
            chapter: "列御寇",
            text: "朱泙漫學屠龍於支離益，單千金之家，三年技成，而無所用其巧。"
        },
        tanli: {
            chapter: "列御寇",
            text: "河上有家貧恃緯蕭而食者，其子沒於淵，得千金之珠。其父謂其子曰「取石來鍛之！夫千金之珠，必在九重之淵而驪龍頷下，子能得珠者，必遭其睡也。使驪龍而寤，子尚奚微之有哉！」"
        },
        duanhe: {
            chapter: "駢拇",
            text: "長者不為有餘，短者不為不足。是故鳧脛雖短，續之則憂；鶴脛雖長，斷之則悲。故性長非所斷，性短非所續，無所去憂也。"
        },
        yanshu: {
            chapter: "逍遙遊",
            text: "鷦鷯巢於深林，不過一枝；偃鼠飲河，不過滿腹。歸休乎君！予無所用天下為。"
        },
        baiju: {
            chapter: "知北遊",
            text: "人生天地之間，若白駒之過郤，忽然而已。"
        },
        zhuojin: {
            chapter: "讓王",
            text: "曾子居衛，縕袍無表，顏色腫噲，手足胼胝。三日不舉火，十年不製衣，正冠而纓絕，捉衿而肘見，納履而踵決。曳縰而歌商頌，聲滿天地，若出金石。"
        },
        qiegou: {
            chapter: "胠篋",
            text: "彼竊鉤者誅，竊國者為諸侯，諸侯之門，而仁義存焉。"
        },
        tianlai: {
            chapter: "齊物論",
            text: "子綦曰：「夫吹萬不同，而使其自已也，咸其自取，怒者其誰邪！」"
        },
        hongmeng: {
            chapter: "在宥",
            text: "雲將東遊，過扶搖之枝，而適遭鴻蒙。鴻蒙方將拊髀雀躍而遊。"
        },
        zuowang: {
            chapter: "大宗師",
            text: "顏回曰：「墮肢體，黜聰明，離形去知，同於大通，此謂坐忘。」"
        },
        zhili: {
            chapter: "人間世",
            text: "支離疏者，頤隱於臍，肩高於頂，會撮指天，五管在上，兩髀為脅。"
        },
        tugu: {
            chapter: "刻意",
            text: "吹呴呼吸，吐故納新，熊經鳥申，為壽而已矣。"
        },
        xinjin: {
            chapter: "養生主",
            text: "指窮於為薪，火傳也，不知其盡也。"
        },
        junzi: {
            chapter: "山木",
            text: "君子之交淡若水，小人之交甘若醴；君子淡以親，小人甘以絕。彼無故以合者，則無故以離。"
        },
        yibu: {
            chapter: "田子方",
            text: "顏淵問於仲尼曰：「夫子步亦步，夫子趨亦趨，夫子馳亦馳，夫子奔逸絕塵，而回瞠若乎後矣。」"
        },
        xuefu: {
            chapter: "天下",
            text: "惠施多方，其書五車，其道舛駁，其言也不中。"
        },
        chenyu: {
            chapter: "齊物論",
            text: "毛嬙、麗姬，人之所美也，魚見之深入，鳥見之高飛，麋鹿見之決驟。四者孰知天下之正色哉？"
        },
        hezhe: {
            chapter: "外物",
            text: "莊周家貧，故往貸粟於監河侯。監河侯曰：「諾。我將得邑金，將貸子三百金，可乎？」莊周忿然作色曰：「周昨來，有中道而呼者。周顧視車轍中，有鮒魚焉。周問之曰：『鮒魚來！子何為者邪？』對曰：『我，東海之波臣也。君豈有斗升之水而活我哉？』周曰：『諾。我且南遊吳、越之王，激西江之水而迎子，可乎？』鮒魚忿然作色曰：『吾失我常與，我無所處。吾得斗升之水然活耳，君乃言此，曾不如早索我於枯魚之肆！』」"
        },
        cutDust: {
            chapter: "徐無鬼",
            text: "莊子送葬，過惠子之墓，顧謂從者曰：「郢人堊慢其鼻端若蠅翼，使匠石斲之。匠石運斤成風，聽而斲之，盡堊而鼻不傷，郢人立不失容。宋元君聞之，召匠石曰：『嘗試為寡人為之。』匠石曰：『臣則嘗能斲之。雖然，臣之質死久矣。』自夫子之死也，吾無以為質矣，吾無與言之矣。」"
        }
    };
    Z.v286StoryOrigins = {
        fish: v286Excerpts.fish,
        forget_fish_trap: v286Excerpts.trap,
        sea_turtle_well_frog: v286Excerpts.seaTurtle,
        huizi: v286Excerpts.huizi,
        huizi_garden: v286Excerpts.debate,
        kunpeng: v286Excerpts.kunpeng,
        butterfly: v286Excerpts.butterfly,
        turtle: v286Excerpts.turtle,
        butcher: { ...v286Excerpts.butcher, note: "梦境变体；原文为庖丁解牛。" },
        oak: v286Excerpts.oak,
        mantis: v286Excerpts.mantis,
        mantis_cicada_oriole: v286Excerpts.mantisCicadaOriole,
        quail: v286Excerpts.quail,
        liezi: v286Excerpts.liezi,
        jieyu: v286Excerpts.jieyu,
        snail: v286Excerpts.snail,
        shadow: v286Excerpts.shadow,
        gourd: v286Excerpts.gourd,
        yuanchu: v286Excerpts.yuanchu,
        zhaosan: v286Excerpts.zhaosan,
        muji: v286Excerpts.muji,
        handan: v286Excerpts.handan,
        dongshi: v286Excerpts.dongshi,
        xiangru: v286Excerpts.xiangru,
        wangyang: v286Excerpts.wangyang,
        xiachong: v286Excerpts.xiachong,
        yuezu: v286Excerpts.yuezu,
        tulong: v286Excerpts.tulong,
        tanli: v286Excerpts.tanli,
        duanhe: v286Excerpts.duanhe,
        yanshu: v286Excerpts.yanshu,
        baiju: v286Excerpts.baiju,
        zhuojin: v286Excerpts.zhuojin,
        hezhe: v286Excerpts.hezhe,
        chenyu: v286Excerpts.chenyu,
        xuefu: v286Excerpts.xuefu,
        yibu: v286Excerpts.yibu,
        junzi: v286Excerpts.junzi,
        xinjin: v286Excerpts.xinjin,
        tugu: v286Excerpts.tugu,
        qiegou: v286Excerpts.qiegou,
        tianlai: v286Excerpts.tianlai,
        hongmeng: v286Excerpts.hongmeng,
        zuowang: v286Excerpts.zuowang,
        zhili: v286Excerpts.zhili,
        fish_splash: { ...v286Excerpts.fish, note: "梦境变体；原文为濠梁观鱼。" },
        fish_bridge: v286Excerpts.fish,
        yuanchu_spring: v286Excerpts.spring,
        grilled_fish: { ...v286Excerpts.fish, note: "梦境变体；原文为濠梁观鱼，未写烤鱼。" },
        burnt_fish: { ...v286Excerpts.fish, note: "梦境变体；原文为濠梁观鱼，未写烤鱼。" },
        huizi_cat: { ...v286Excerpts.huizi, note: "梦境变体；原文为庄子与惠子的论辩。" },
        huizi_cat_close: { ...v286Excerpts.debate, note: "梦境变体；原文为庄子与惠子的论辩。" },
        zh_cut_dust: { ...v286Excerpts.cutDust, note: "梦境变体；原文挥斧者为匠石，受斲者为郢人。" },
        hz_return_cut: { ...v286Excerpts.cutDust, note: "梦境变体；原文挥斧者为匠石，受斲者为郢人。" },
        hz_two_axes: { ...v286Excerpts.cutDust, note: "梦境变体；原文挥斧者为匠石，未写双斧。" },
        zhuang_hui_boat: { ...v286Excerpts.gourd, note: "梦境变体；原文提出浮乎江湖，未写庄惠同舟。" }
    };
    Z.v283StoryTexts = Object.fromEntries(
        Object.entries(Z.v286StoryOrigins).map(([id, origin]) => [id, origin.text])
    );
    Z.v283CloseStory = () => {
        if (Z.v283StoryKeyHandler && typeof document !== "undefined") {
            try { document.removeEventListener("keydown", Z.v283StoryKeyHandler, true); } catch (e) {}
        }
        Z.v283StoryKeyHandler = null;
        if (Z.v283StoryHost) {
            try { Z.v283StoryHost.remove(); } catch (e) {}
        }
        Z.v283StoryHost = null;
    };
    Z.v283StoryText = image => Z.v283StoryTexts[image?.id] ||
        "暂无对应的《庄子》原文摘录。";
    Z.v283OpenStory = player => {
        if (typeof document === "undefined" || !document.body || !Z.v215ImageryActive ||
            !Z.local(game.me) || !Z.blind(game.me) || !player || player === game.me) return;
        const image = Z.v215GetImagery?.(player) || Z.v215ImageryMap.get(player);
        if (!image) return;
        Z.v283CloseStory();
        const host = document.createElement("div");
        host.className = "xd-zz-v283-story-host";
        host.tabIndex = -1;
        const root = host.attachShadow ? host.attachShadow({ mode: "open" }) : host;
        const style = document.createElement("style");
        style.textContent = `
            :host { all:initial!important; position:fixed!important; inset:0!important; z-index:2147483600!important;
                display:block!important; pointer-events:auto!important; font:15px/1.65 Arial,"Noto Sans CJK SC","Microsoft YaHei",sans-serif!important;
                color:#243d4b!important; }
            *,*::before,*::after { box-sizing:border-box!important; }
            .backdrop { position:absolute!important; inset:0!important; display:flex!important; align-items:center!important; justify-content:center!important;
                padding:24px!important; background:rgba(9,18,24,.52)!important; backdrop-filter:blur(2px)!important; }
            .panel { --story-content-height:calc(min(78vh,760px) - 50px); position:relative!important; width:min(760px,92vw)!important;
                max-height:min(78vh,760px)!important; overflow:auto!important;
                display:grid!important; grid-template-columns:minmax(180px,270px) minmax(0,1fr)!important; align-items:start!important;
                gap:22px!important; padding:24px!important;
                border:1px solid rgba(124,157,171,.72)!important; border-radius:16px!important;
                background:linear-gradient(145deg,rgba(245,249,247,.98),rgba(225,237,239,.98))!important;
                box-shadow:0 20px 70px rgba(0,0,0,.38)!important; }
            .panel,p { scrollbar-width:thin!important; scrollbar-color:rgba(95,130,145,.45) transparent!important; }
            .panel::-webkit-scrollbar,p::-webkit-scrollbar { width:5px!important; }
            .panel::-webkit-scrollbar-track,p::-webkit-scrollbar-track { background:transparent!important; }
            .panel::-webkit-scrollbar-thumb,p::-webkit-scrollbar-thumb { background:rgba(95,130,145,.45)!important; border-radius:5px!important; }
            .artbox { min-width:0!important; align-self:start!important; border-radius:12px!important; overflow:hidden!important; display:flex!important; align-items:center!important;
                justify-content:center!important; background:linear-gradient(145deg,#dbe9ea,#bfd7dd)!important; border:1px solid rgba(92,133,151,.5)!important; }
            .artbox img { width:100%!important; height:auto!important; max-height:calc(var(--story-content-height) - 2px)!important; object-fit:contain!important; display:block!important; }
            .glyph { width:100%!important; min-height:min(210px,calc(var(--story-content-height) - 2px))!important; display:grid!important; place-items:center!important;
                font:700 64px/1 "Noto Serif CJK SC","Songti SC","SimSun",serif!important; color:#355c6f!important; }
            .copy { min-width:0!important; min-height:0!important; max-height:var(--story-content-height)!important;
                display:flex!important; flex-direction:column!important; }
            .eyebrow,h2,.note { flex:none!important; }
            .eyebrow { margin:0 0 5px!important; font-size:12px!important; letter-spacing:.16em!important; color:#718995!important; }
            h2 { margin:0 32px 12px 0!important; font:700 26px/1.25 "Noto Serif CJK SC","Songti SC","SimSun",serif!important; color:#25495a!important; }
            p { margin:0!important; min-height:0!important; overflow-y:auto!important; overscroll-behavior:contain!important;
                padding-right:6px!important;
                white-space:pre-wrap!important; font-size:15px!important; color:#304b58!important; }
            .note { margin-top:16px!important; padding-top:12px!important; border-top:1px solid rgba(95,130,145,.28)!important;
                font-size:12px!important; color:#758b94!important; }
            button { position:absolute!important; top:12px!important; right:12px!important; width:34px!important; height:34px!important; border:0!important;
                border-radius:999px!important; background:rgba(65,91,103,.1)!important; color:#36515e!important; font:22px/34px Arial,sans-serif!important;
                cursor:pointer!important; padding:0!important; }
            button:hover { background:rgba(65,91,103,.18)!important; }
            @media (max-width:620px) { .panel { --story-content-height:calc(min(78vh,760px) - 38px);
                    grid-template-columns:1fr!important; gap:14px!important; padding:18px!important; }
                .artbox { width:min(100%,250px)!important; justify-self:center!important; }
                .copy { max-height:none!important; }
                p { overflow:visible!important; padding-right:0!important; } }
        `;
        const backdrop = document.createElement("div");
        backdrop.className = "backdrop";
        const panel = document.createElement("div");
        panel.className = "panel";
        const artbox = document.createElement("div");
        artbox.className = "artbox";
        if (image.art) {
            const img = document.createElement("img");
            img.alt = "";
            img.decoding = "async";
            img.src = Z.v219ArtUrl(image.art);
            img.onerror = () => {
                img.remove();
                const glyph = document.createElement("div");
                glyph.className = "glyph";
                glyph.textContent = image.glyph || "梦";
                artbox.appendChild(glyph);
            };
            artbox.appendChild(img);
        } else {
            const glyph = document.createElement("div");
            glyph.className = "glyph";
            glyph.textContent = image.glyph || "梦";
            artbox.appendChild(glyph);
        }
        const copy = document.createElement("div");
        copy.className = "copy";
        const eyebrow = document.createElement("div");
        eyebrow.className = "eyebrow";
        eyebrow.textContent = "梦中角色形象";
        const title = document.createElement("h2");
        title.textContent = image.name || "梦中形象";
        const body = document.createElement("p");
        body.textContent = Z.v283StoryText(image);
        const note = document.createElement("div");
        note.className = "note";
        const origin = Z.v286StoryOrigins[image.id];
        note.textContent = origin?.chapter || "";
        note.hidden = !note.textContent;
        note.style.whiteSpace = "pre-wrap";
        copy.append(eyebrow, title, body, note);
        const close = document.createElement("button");
        close.type = "button";
        close.setAttribute("aria-label", "关闭故事介绍");
        close.textContent = "×";
        close.addEventListener("click", e => { e.preventDefault(); e.stopPropagation(); Z.v283CloseStory(); });
        panel.append(artbox, copy, close);
        backdrop.appendChild(panel);
        root.append(style, backdrop);
        backdrop.addEventListener("click", e => {
            if (e.target === backdrop) { e.preventDefault(); e.stopPropagation(); Z.v283CloseStory(); }
        });
        panel.addEventListener("click", e => e.stopPropagation());
        Z.v283StoryKeyHandler = e => {
            if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); Z.v283CloseStory(); }
        };
        document.addEventListener("keydown", Z.v283StoryKeyHandler, true);
        document.body.appendChild(host);
        Z.v283StoryHost = host;
        try { host.focus({ preventScroll:true }); } catch (e) { try { host.focus(); } catch (e2) {} }
    };
    Z.v283InstallDreamIntroGuard = () => {
        if (Z.v283DreamIntroGuard || typeof document === "undefined") return;
        const eventName = lib.config.touchscreen ? "touchend" : "click";
        const handler = event => {
            if (!Z.v215ImageryActive || !Z.local(game.me) || !Z.blind(game.me) || Z.ended) return;
            const target = event.target;
            if (!target?.closest) return;
            let player = null;
            let tapNode = null;
            const shell = target.closest(".xd-zz-v282-dead-shell");
            if (shell?._xd_zz_player) {
                player = shell._xd_zz_player;
                tapNode = shell;
            } else {
                const avatar = target.closest(".avatar,.avatar2");
                const masked = avatar?.closest?.(".player.xd-zz-v215-masked");
                if (!avatar || !masked) return;
                player = masked;
                tapNode = avatar;
            }
            if (!player || player === game.me || !tapNode) return;
            const now = Date.now();
            const last = Z.v283LastDreamTap.get(tapNode) || 0;
            if (now - last <= 500) {
                Z.v283LastDreamTap.delete(tapNode);
                try { tapNode._doubleClicking = false; } catch (e) {}
                event.preventDefault?.();
                event.stopPropagation?.();
                event.stopImmediatePropagation?.();
                Z.v283OpenStory(player);
                return;
            }
            Z.v283LastDreamTap.set(tapNode, now);
        };
        document.addEventListener(eventName, handler, true);
        Z.v283DreamIntroGuard = { eventName, handler };
    };

    // V2.8.2：死亡本身是现实状态，不应在庄周闭眼时通过阵亡章、翻面或上移泄露。
    // 真正 player 仍照常死亡并进入 game.dead；这里只有一个本地、可点击的梦境外壳。
    // 外壳保存该角色死亡前最后一个“角色形象”，点击时仍把真实 player 交还给选择系统。
    Z.v282DeadDreamShells = new Map();
    Z.v282DreamSeatSizes = new Map();
    // 闭眼前保存主题实际使用的外框；阵亡外壳沿用它，不读取死亡后的灰化/阴影。
    Z.v298ReadDreamFrame = player => {
        if (!player || typeof getComputedStyle !== "function") return null;
        try {
            const style = getComputedStyle(player);
            // v302：活人框的深色底（主题的 background-image 渐变/木纹）和外圈阴影都要一并带走，
            // 否则阵亡外壳露出透明底，外圈明显变浅，一眼能看出已阵亡。
            const frame = Object.fromEntries(Z.v302FrameProps.map(name => [name, style.getPropertyValue(name)]));
            // 部分布局在 .player > .framebg 上画金/银/铜边框装饰；活人被遮挡时它仍可见，外壳同样复制一份。
            const framebg = Array.from(player.children || []).find(node => node.classList?.contains("framebg"));
            if (framebg) {
                const box = getComputedStyle(framebg);
                const outer = player.getBoundingClientRect(), inner = framebg.getBoundingClientRect();
                if (box.display !== "none" && box.visibility !== "hidden" && outer.width > 0 && outer.height > 0 &&
                    inner.width > 0 && inner.height > 0) {
                    const pseudo = name => {
                        const value = getComputedStyle(framebg, name);
                        if (!value || value.content === "none" || value.display === "none") return null;
                        return Object.fromEntries(Z.v302PseudoProps.map(prop => [prop, value.getPropertyValue(prop)]));
                    };
                    Object.defineProperty(frame, "__framebg", { enumerable: false, value: {
                        left: (inner.left - outer.left) / outer.width, top: (inner.top - outer.top) / outer.height,
                        width: inner.width / outer.width, height: inner.height / outer.height,
                        style: Object.fromEntries(Z.v302FrameProps.concat(["opacity", "z-index"]).map(name => [name, box.getPropertyValue(name)])),
                        before: pseudo("::before"), after: pseudo("::after"),
                    } });
                }
            }
            return frame;
        } catch (e) { return null; }
    };
    Z.v302FrameProps = ["box-shadow", "border-radius", "background-color", "background-image", "background-size",
        "background-position", "background-repeat", "background-origin", "background-clip",
        "outline-style", "outline-width", "outline-color", "outline-offset",
        "border-image-source", "border-image-slice", "border-image-width", "border-image-outset", "border-image-repeat"];
    for (const side of ["top", "right", "bottom", "left"]) {
        for (const part of ["width", "style", "color"]) Z.v302FrameProps.push("border-" + side + "-" + part);
    }
    Z.v302PseudoProps = Z.v302FrameProps.concat(["content", "position", "left", "top", "width", "height",
        "transform", "opacity", "z-index", "display"]);
    Z.v302PseudoSerial = 0;
    Z.v302ApplyFramebg = (shell, frame) => {
        const info = frame?.__framebg;
        if (!info || typeof document === "undefined") return;
        const layer = document.createElement("div");
        layer.className = "xd-zz-v302-framebg";
        const id = "zzfb" + (++Z.v302PseudoSerial);
        layer.setAttribute("data-zz-framebg", id);
        layer.style.setProperty("position", "absolute", "important");
        layer.style.setProperty("left", info.left * 100 + "%", "important");
        layer.style.setProperty("top", info.top * 100 + "%", "important");
        layer.style.setProperty("width", info.width * 100 + "%", "important");
        layer.style.setProperty("height", info.height * 100 + "%", "important");
        layer.style.setProperty("pointer-events", "none", "important");
        for (const [property, value] of Object.entries(info.style)) {
            if (value && property !== "z-index") layer.style.setProperty(property, value, "important");
        }
        layer.style.setProperty("z-index", "1", "important");
        const rules = [];
        for (const [name, values] of [["::before", info.before], ["::after", info.after]]) {
            if (!values) continue;
            const body = Object.entries(values).filter(([, value]) => value)
                .map(([property, value]) => property + ":" + value + "!important").join(";");
            rules.push(`.xd-zz-v302-framebg[data-zz-framebg="${id}"]${name}{${body}}`);
        }
        if (rules.length) {
            const style = document.createElement("style");
            style.textContent = rules.join("\n");
            layer.appendChild(style);
        }
        shell.insertBefore(layer, shell.firstChild);
    };
    Z.v298DreamBodySpace = () => {
        // 本体 ui.updatez 会 scale(body)。body 下的 fixed 外壳必须使用缩放前的坐标。
        const space = { left: 0, top: 0, x: 1, y: 1 };
        if (typeof document === "undefined" || typeof getComputedStyle !== "function") return space;
        const body = document.body;
        try {
            if (body && getComputedStyle(body).transform !== "none") {
                const rect = body.getBoundingClientRect();
                if (body.offsetWidth > 0 && body.offsetHeight > 0 && rect.width > 0 && rect.height > 0) {
                    return { left: rect.left, top: rect.top, x: rect.width / body.offsetWidth, y: rect.height / body.offsetHeight };
                }
            }
        } catch (e) {}
        return space;
    };
    Z.v282SnapshotDreamSeatSizes = players => {
        Z.v282DreamSeatSizes.clear();
        const living = (game.players || []).find(current => current !== game.me && !(game.dead || []).includes(current));
        const livingFrame = Z.v298ReadDreamFrame(living || game.me);
        const bodySpace = Z.v298DreamBodySpace();
        for (const current of players || []) {
            try {
                const rect = current?.getBoundingClientRect?.();
                if (rect && rect.width > 0 && rect.height > 0) {
                    const frame = (game.dead || []).includes(current)
                        ? livingFrame : Z.v298ReadDreamFrame(current);
                    const alreadyDead = (game.dead || []).includes(current);
                    // 睁眼时已阵亡者的原生翻转不能影响新一轮梦境卡位的宽高。
                    const width = alreadyDead && current.offsetWidth > 0 ? current.offsetWidth * bodySpace.x : rect.width;
                    const height = alreadyDead && current.offsetHeight > 0 ? current.offsetHeight * bodySpace.y : rect.height;
                    Z.v282DreamSeatSizes.set(current, { width, height, frame: frame || livingFrame });
                }
            } catch (e) {}
        }
    };
    Z.v282DeadShellGeometry = player => {
        let rect = null;
        try { rect = player?.getBoundingClientRect?.() || null; } catch (e) {}
        const saved = Z.v282DreamSeatSizes.get(player);
        const width = saved?.width || (rect?.width > 0 ? rect.width : 104);
        const height = saved?.height || (rect?.height > 0 ? rect.height : 140);
        const seat = Z.seatLayout?.get?.(player);
        const left = seat && typeof window !== "undefined"
            ? seat.x * window.innerWidth - width / 2
            : (rect?.left || 0);
        const top = seat && typeof window !== "undefined"
            ? seat.y * window.innerHeight - height / 2
            : (rect?.top || 0);
        const space = Z.v298DreamBodySpace();
        return { left: (left - space.left) / space.x, top: (top - space.top) / space.y,
            width: width / space.x, height: height / space.y };
    };
    Z.v282RemoveDeadDreamShell = player => {
        const record = Z.v282DeadDreamShells.get(player);
        if (record) {
            try { record.shell?.remove(); } catch (e) {}
            Z.v282DeadDreamShells.delete(player);
        }
        try { player?.classList?.remove?.("xd-zz-v282-dead-source-hidden"); } catch (e) {}
    };
    Z.v282ClearDeadDreamShells = () => {
        for (const player of Array.from(Z.v282DeadDreamShells.keys())) Z.v282RemoveDeadDreamShell(player);
        // 极端情况下外壳记录已丢失，也把本地隐藏标记撤掉。
        for (const current of [...(game.players || []), ...(game.dead || [])]) {
            try { current?.classList?.remove?.("xd-zz-v282-dead-source-hidden"); } catch (e) {}
        }
        Z.v282DreamSeatSizes.clear();
    };
    Z.v282ForwardDeadTarget = (player, event) => {
        // 优先进入庄周自己的盲选代理；没有代理时再退回原生 target handler。
        try {
            for (const session of Z.v2ActiveSessions || []) {
                if (!session || session.destroyed || session.suspended || get.event() !== session.event) continue;
                if (typeof session.installed?.target === "function") {
                    session.installed.target(player);
                    return;
                }
            }
        } catch (e) {}
        try { ui?.click?.target?.call?.(player, event); } catch (e) {}
    };
    Z.v282EnsureDeadDreamShell = player => {
        if (!player || player === game.me || typeof document === "undefined" || !document.body) return;
        const image = Z.v215GetImagery(player);
        if (!image) return;
        const key = [image.id, image.name, image.glyph, image.hue, image.art || ""].join("\u0001");
        let record = Z.v282DeadDreamShells.get(player);
        if (!record?.shell?.isConnected) {
            const shell = document.createElement("div");
            shell.className = "xd-zz-v282-dead-shell";
            shell._xd_zz_player = player;
            shell.setAttribute("aria-label", "角色形象·" + image.name);

            const veil = document.createElement("div");
            veil.className = "xd-zz-v215-veil";
            veil.style.setProperty("--zz-ink", image.hue);
            veil.setAttribute("aria-label", "角色形象·" + image.name);
            const art = Z.v219MakeArt(veil, image);
            const glyph = document.createElement("span");
            glyph.className = "xd-zz-v215-glyph";
            glyph.textContent = image.glyph;
            const name = document.createElement("span");
            name.className = "xd-zz-v215-name";
            name.textContent = image.name;
            const edit = document.createElement("button");
            edit.type = "button";
            edit.className = "xd-zz-v216-edit";
            edit.textContent = "换";
            edit.setAttribute("aria-label", "更换角色形象");
            // V2.8.5：死者外壳也保留“换”。按钮只操作庄周本地梦境笔记，
            // 不复活、不移动真实死者，也不把点击继续传给目标选择。
            for (const eventName of ["pointerdown", "pointerup", "mousedown", "mouseup", "touchstart", "touchend"]) {
                edit.addEventListener(eventName, e => { e.stopPropagation(); });
            }
            edit.addEventListener("click", e => {
                e.preventDefault();
                e.stopPropagation();
                Z.v216OpenChooser(player);
            });
            veil.append(art, glyph, name, edit);
            shell.appendChild(veil);

            const geometry = Z.v282DeadShellGeometry(player);
            shell.style.setProperty("left", geometry.left + "px", "important");
            shell.style.setProperty("top", geometry.top + "px", "important");
            shell.style.setProperty("width", geometry.width + "px", "important");
            shell.style.setProperty("height", geometry.height + "px", "important");
            const savedFrame = Z.v282DreamSeatSizes.get(player)?.frame;
            for (const [property, value] of Object.entries(savedFrame || {})) {
                if (value) shell.style.setProperty(property, value, "important");
            }
            Z.v302ApplyFramebg(shell, savedFrame);

            const eventName = lib.config.touchscreen ? "touchend" : "click";
            shell.addEventListener(eventName, event => {
                event.preventDefault?.();
                event.stopPropagation?.();
                Z.v282ForwardDeadTarget(player, event);
            });
            document.body.appendChild(shell);
            record = { shell, veil, art, glyph, name, edit, key: "" };
            Z.v282DeadDreamShells.set(player, record);
        }
        player.classList?.add?.("xd-zz-v282-dead-source-hidden");
        if (record.key !== key) {
            record.veil.style.setProperty("--zz-ink", image.hue);
            record.glyph.textContent = image.glyph;
            record.name.textContent = image.name;
            record.shell.setAttribute("aria-label", "角色形象·" + image.name);
            record.veil.setAttribute("aria-label", "角色形象·" + image.name);
            record.edit?.setAttribute("aria-label", "更换“" + image.name + "”的角色形象");
            Z.v219SyncArt(record.veil, record.art, image);
            record.key = key;
        }
        const selected = !!player.classList?.contains?.("xd-zz-v2-proto-selected");
        if (record.selected !== selected) {
            record.shell.classList.toggle("xd-zz-v2-proto-selected", selected);
            record.selected = selected;
        }
    };
    Z.v282SyncDeadDreamShells = player => {
        const dead = (game.dead || []).filter(current => current && current !== player);
        const current = new Set(dead);
        for (const shellPlayer of Array.from(Z.v282DeadDreamShells.keys())) {
            if (!current.has(shellPlayer)) Z.v282RemoveDeadDreamShell(shellPlayer);
        }
        for (const deadPlayer of dead) Z.v282EnsureDeadDreamShell(deadPlayer);
    };

    Z.v215RemoveOverlays = () => {
        Z.v215CloseChooser();
        Z.v282ClearDeadDreamShells?.();
        for (const [player, record] of Z.v215Overlays) {
            try { record.node?.classList?.remove("xd-zz-v215-masked"); } catch (e) {}
            try { record.overlay?.remove(); } catch (e) {}
            try {
                if (record.originalAriaLabel === null) record.node?.removeAttribute?.("aria-label");
                else record.node?.setAttribute?.("aria-label", record.originalAriaLabel);
            } catch (e) {}
            if (record.node && "originalNoIntro" in record) {
                if (record.originalNoIntro === undefined) delete record.node._nointro;
                else record.node._nointro = record.originalNoIntro;
            }
        }
        Z.v215Overlays.clear();
    };
    // V2.7.37: one-shot dream entry/exit stage lighting. No persistent
    // particles, no extra gameplay state, and never intercept mouse targets.
    Z.v237Curtain = null;
    Z.v237Leaving = new Set();
    Z.v237ClearCurtain = () => {
        if (!Z.v237Curtain) return;
        if (Z.v237Curtain._xd_zz_timer) clearTimeout(Z.v237Curtain._xd_zz_timer);
        try { Z.v237Curtain.remove(); } catch (e) {}
        Z.v237Curtain = null;
    };
    Z.v237ClearLeaving = () => {
        for (const ghost of Z.v237Leaving) {
            if (ghost._xd_zz_timer) clearTimeout(ghost._xd_zz_timer);
            try { ghost.remove(); } catch (e) {}
        }
        Z.v237Leaving.clear();
    };
    Z.v237PlayCurtain = mode => {
        if (typeof document === "undefined" || !document.body) return;
        Z.v237ClearCurtain();
        const curtain = document.createElement("div");
        curtain.className = "xd-zz-v237-curtain xd-zz-v237-curtain-" + (mode === "exit" ? "exit" : "enter");
        curtain.setAttribute("aria-hidden", "true");
        document.body.appendChild(curtain);
        Z.v237Curtain = curtain;
        const finish = () => {
            if (Z.v237Curtain !== curtain) return;
            Z.v237ClearCurtain();
        };
        curtain.addEventListener("animationend", e => { if (e.target === curtain) finish(); }, { once:true });
        curtain._xd_zz_timer = setTimeout(finish, 850);
    };
    Z.v237DepartPortraits = () => {
        if (typeof document === "undefined" || !document.body) return;
        Z.v237ClearLeaving();
        // Snapshot ONLY the visible image surface just before original player
        // DOM is unmasked. These inert ghosts dissolve over the real portraits.
        for (const [player, record] of Z.v215Overlays) {
            if (!record.overlay?.isConnected || !player?.getBoundingClientRect) continue;
            const r = player.getBoundingClientRect();
            if (!(r.width > 0 && r.height > 0)) continue;
            const ghost = document.createElement("div");
            ghost.className = "xd-zz-v215-masked xd-zz-v237-leavehost";
            ghost.setAttribute("aria-hidden", "true");
            ghost.style.setProperty("left", r.left + "px", "important");
            ghost.style.setProperty("top", r.top + "px", "important");
            ghost.style.setProperty("width", r.width + "px", "important");
            ghost.style.setProperty("height", r.height + "px", "important");
            const surface = record.overlay.cloneNode(true);
            surface.classList.remove("xd-zz-v237-entering", "xd-zz-v219-switchfx");
            surface.style.removeProperty("animation-delay");
            surface.querySelector?.(".xd-zz-v216-edit")?.remove();
            surface.querySelector?.(".xd-zz-v219-art")?.classList?.remove("xd-zz-v219-swapping");
            ghost.appendChild(surface);
            document.body.appendChild(ghost);
            Z.v237Leaving.add(ghost);
            const finish = () => {
                if (ghost._xd_zz_timer) clearTimeout(ghost._xd_zz_timer);
                try { ghost.remove(); } catch (e) {}
                Z.v237Leaving.delete(ghost);
            };
            ghost.addEventListener("animationend", e => { if (e.target === ghost) finish(); }, { once:true });
            ghost._xd_zz_timer = setTimeout(finish, 620);
        }
    };
    Z.v215StopImagery = () => {
        Z.v296SyncWuxieDialogs?.(true);
        if (Z.v215ImageryActive && !Z.ended) {
            Z.v237DepartPortraits?.();
            Z.v237PlayCurtain?.("exit");
        }
        Z.v226StopDreamReport?.();
        Z.v241StopDreamWallpaper?.();
        Z.v283CloseStory?.();
        if (Z.v215ImageryActive) Z.v215PreviousMap = new Map(Z.v215ImageryMap);
        Z.v215ImageryActive = false;
        Z.v215ImageryMap.clear();
        Z.v239DuelStates.clear();
        Z.v239HarmlessProgress.clear();
        Z.v239CatForms.clear();
        Z.v239CatLocked.clear();
        Z.v239CandidateUses = new WeakMap();
        Z.v239FinishedUses = new WeakSet();
        Z.v215RemoveOverlays();
        // 不清理手动标记；它们将在本局下一次闭眼时重新覆盖随机结果。
    };
    Z.v220PersistentForms = new Map();
    Z.v220Lookup = id => Z.v215ImageryPool.find(item => item.id === id);
    Z.v220CurrentId = player => Z.v215ImageryMap.get(player)?.id || Z.v215ManualImage(player)?.id || "";
    Z.v220IsFishId = id => ["fish", "fish_bridge", "fish_splash", "grilled_fish", "burnt_fish"].includes(id);
    Z.v220IsHuiziId = id => ["huizi", "huizi_garden", "huizi_cat", "huizi_cat_close"].includes(id);
    Z.v220ApplyVisual = (player, id, options = {}) => {
        const base = Z.v220Lookup(id);
        if (!base || !player) return false;
        const image = Z.v287GrilledImage(player, base, id === "grilled_fish");
        if (options.persistent) Z.v220PersistentForms.set(player, id);
        else if (options.clearPersistent) Z.v220PersistentForms.delete(player);
        Z.v215ImageryMap.set(player, image);
        Z.v216RefreshOverlayNames();
        return true;
    };
    Z.v220GoodHuiziCard = (card, source, target) => {
        const name = get.name(card, source) || card?.name;
        if (["wuzhong", "taoyuan", "wugu", "tao", "jiu"].includes(name)) return true;
        if (name === "tiesuo") return !!target?.isLinked?.();
        return false;
    };
    // 战报使用事件发生时的意象快照，绝不从原生武将身份推断或补充隐藏资料。
    Z.v220OnTargeted = (source, target, card) => {
        if (!Z.v215ImageryActive || !Z.blind(game.me) || !target || target === game.me) return null;
        const currentId = Z.v220CurrentId(target);
        if (currentId === "fish") {
            if (Z.v220ApplyVisual(target, "fish_bridge")) return { from: currentId, to: "fish_bridge" };
            return null;
        }
        if (currentId === "yuanchu") {
            if (Z.v220ApplyVisual(target, "yuanchu_spring")) return { from: currentId, to: "yuanchu_spring" };
            return null;
        }
        if (Z.v220IsHuiziId(currentId) && source === game.me && !Z.v220GoodHuiziCard(card, source, target)) {
            // 近景惠子对应近景虎威，论道惠子对应论道虎威；手动选的虎威不被覆盖。
            const catId = currentId === "huizi_garden" ? "huizi_cat_close" :
                currentId === "huizi" ? "huizi_cat" : null;
            if (catId && Z.v220ApplyVisual(target, catId)) return { from: currentId, to: catId };
        }
        return null;
    };
    // 采用伤害事件的最终属性：藤甲等改写后的火焰伤害也算；一段伤害只推进一态。
    Z.v226IsFireDamage = event => {
        try { if (event?.hasNature?.("fire")) return true; } catch (e) {}
        return Z.nature(event?.nature).split("|").includes("fire");
    };
    Z.v220OnDamaged = (target, event) => {
        if (!Z.v215ImageryActive || !Z.blind(game.me) || !target || target === game.me || !(event?.num > 0)) return null;
        const currentId = Z.v220CurrentId(target);
        if (currentId === "gourd") {
            if (Z.v220ApplyVisual(target, "zhuang_hui_boat")) return { from: currentId, to: "zhuang_hui_boat" };
            return null;
        }
        if (!Z.v220IsFishId(currentId) || currentId === "burnt_fish") return null;
        const fire = Z.v226IsFireDamage(event);
        if (fire) {
            const nextId = currentId === "grilled_fish" ? "burnt_fish" : "grilled_fish";
            const manualBase = Z.v215ManualImagery.get(target);
            // 只有手动固定的鱼／烤鱼跨闭眼保留烹饪结果；随机抽到的鱼下次重抽。
            const persistent = ["fish", "grilled_fish"].includes(manualBase);
            if (Z.v220ApplyVisual(target, nextId, { persistent })) return { from: currentId, to: nextId };
            return null;
        }
        if (currentId !== "grilled_fish" && currentId !== "fish_splash" &&
            Z.v220ApplyVisual(target, "fish_splash")) return { from: currentId, to: "fish_splash" };
        return null;
    };
    // V2.7.39：庄惠削灰彩蛋独立于技能结算，只追踪本次闭眼的公开用牌与实际伤害。
    // 玩家真实身份无关：只要梦中是惠子系（可以把勾践手动标为惠子），就能参与。
    Z.v239DuelForms = new Set(["zh_cut_dust", "hz_return_cut", "hz_two_axes"]);
    Z.v239DuelStates = new Map();             // 对方 player 对象 -> 当前来回阶段
    // V2.7.44: 猫图优先。完成庄周→惠子→庄周的无伤往返后才开始削灰。
    // 只统计双方依次用牌而且整张牌未造成伤害的事件；具体门槛可调整。
    Z.v239NoDamageUsesRequired = 3;
    Z.v239HarmlessProgress = new Map();       // 对方 player 对象 -> { count, lastDirection }
    Z.v239CatForms = new Map();               // 保存本次闭眼中近景/论道的对应猫图
    Z.v239CatLocked = new Set();              // 惠子确实受伤后，本次闭眼不再自动换成削灰图
    Z.v239CandidateUses = new WeakMap();      // 同一次原生 useCard 事件 -> 候选双方
    Z.v239FinishedUses = new WeakSet();       // 全局技能偶尔重复进入，同一张牌绝不重复计数
    Z.v239GetUseEvent = event => {
        let current = event;
        for (let i = 0; current && i < 18; i++) {
            if (current.name === "useCard") return current;
            let next;
            try { next = typeof current.getParent === "function" ? current.getParent() : current.parent; }
            catch (e) { break; } // 监听彩蛋不能打断原生用牌链。
            if (!next || next === current) break;
            current = next;
        }
        return null;
    };
    Z.v239Eligible = other => {
        if (!other || other === game.me || !Z.v215ImageryActive || !Z.blind(game.me)) return false;
        const current = Z.v220CurrentId(other);
        const manual = Z.v215ManualImagery.get(other);
        return Z.v220IsHuiziId(current) || Z.v220IsHuiziId(manual) ||
            Z.v239DuelForms.has(current) || Z.v239DuelForms.has(manual);
    };
    Z.v239RememberCatForm = other => {
        const current = Z.v220CurrentId(other);
        const manual = Z.v215ManualImagery.get(other);
        if (current === "huizi_garden" || current === "huizi_cat_close" ||
            manual === "huizi_garden" || manual === "huizi_cat_close") {
            Z.v239CatForms.set(other, "huizi_cat_close");
        } else if (current === "huizi" || current === "huizi_cat") {
            Z.v239CatForms.set(other, "huizi_cat");
        } else if (!Z.v239CatForms.has(other)) {
            // 手工选择的削灰图，没有原始近景/论道信息时，使用普通猫图。
            Z.v239CatForms.set(other, "huizi_cat");
        }
    };
    Z.v239ResetToCat = (other, lock = false) => {
        if (!Z.v239Eligible(other)) return null;
        const from = Z.v220CurrentId(other);
        // 两张原始惠子图仅由庄周用坏牌指定目标时换成虎威；受伤或交锋失败不能跳过此入口。
        if (from === "huizi" || from === "huizi_garden") return null;
        Z.v239RememberCatForm(other);
        if (lock) Z.v239CatLocked.add(other);
        Z.v239DuelStates.delete(other);
        Z.v239HarmlessProgress.delete(other);
        const nextId = Z.v239CatForms.get(other) || "huizi_cat";
        if (from === nextId || !Z.v220ApplyVisual(other, nextId)) return null;
        return { from, to: nextId };
    };
    Z.v239RegisterTarget = (useEvent, source, target) => {
        if (!useEvent || !source || !target || source === target || !Z.v215ImageryActive || !Z.blind(game.me)) return;
        let other = null;
        let direction = null;
        if (source === game.me && Z.v239Eligible(target)) {
            other = target; direction = "zhuangzhou";
        } else if (target === game.me && Z.v239Eligible(source)) {
            other = source; direction = "counterpart";
        }
        if (!other) return;
        Z.v239RememberCatForm(other);
        let candidates = Z.v239CandidateUses.get(useEvent);
        if (!candidates) {
            candidates = new Map();
            Z.v239CandidateUses.set(useEvent, candidates);
        }
        if (!candidates.has(other)) candidates.set(other, { direction, damaged: false });
    };
    Z.v239BeginUse = useEvent => {
        if (!useEvent || !Array.isArray(useEvent.targets)) return;
        for (const target of useEvent.targets) Z.v239RegisterTarget(useEvent, useEvent.player, target);
    };
    Z.v239RegisterDamage = damage => {
        if (!(damage?.num > 0)) return;
        // 只认发生在本次牌结算之下的真正伤害，不能以 card 名称/回合/时间推断。
        const useEvent = Z.v239GetUseEvent(damage);
        if (!useEvent) return;
        const candidates = Z.v239CandidateUses.get(useEvent);
        if (!candidates) return;
        // 这一张牌若造成任何实际伤害，就不属于“削灰而不伤”的过招。
        for (const candidate of candidates.values()) candidate.damaged = true;
    };
    Z.v239NextStep = (state, direction) => {
        if (!state) return direction === "zhuangzhou" ? 1 : 0;
        if (state.step === 1 && direction === "counterpart") return 2;
        if (state.step === 2 && direction === "zhuangzhou") return 3;
        if (state.step === 3 && direction === "counterpart") return 4;
        // 此后让庄子再来一斧，惠子用双斧继续回敬。
        if (state.step === 4 && direction === "zhuangzhou") return 3;
        return state.step;
    };
    Z.v239StepArt = step => step === 1 || step === 3 ? "zh_cut_dust" :
        step === 2 ? "hz_return_cut" : step === 4 ? "hz_two_axes" : "";
    Z.v239FinalizeUse = useEvent => {
        if (!useEvent || !Z.v215ImageryActive || !Z.blind(game.me) || Z.v239FinishedUses.has(useEvent)) return;
        Z.v239FinishedUses.add(useEvent);
        Z.v239BeginUse(useEvent); // 原生最终目标集可能比 useCard1 多（例如追加目标）。
        const candidates = Z.v239CandidateUses.get(useEvent);
        if (!candidates) return;
        for (const [other, candidate] of candidates) {
            if (!Z.v239Eligible(other)) continue;
            if (Z.v239CatLocked.has(other)) continue;
            if (candidate.damaged) {
                // 任一方此次用牌造成伤害，都中断无伤交锋；若惠子受伤，
                // damageEnd 已将他锁定为猫图，这里不重复换图。
                Z.v226RecordTransformation(other, Z.v239ResetToCat(other));
                continue;
            }
            let state = Z.v239DuelStates.get(other);
            if (!state) {
                // 玩家主动改标到削灰图后，沿用原来从所选阶段继续的行为。
                const form = Z.v220CurrentId(other);
                const step = form === "zh_cut_dust" ? 1 : form === "hz_return_cut" ? 2 :
                    form === "hz_two_axes" ? 4 : 0;
                state = step ? { step } : null;
            }
            if (!state) {
                // 未显示过猫图时，不因为无伤用牌提前触发削灰。
                const form = Z.v220CurrentId(other);
                if (form !== "huizi_cat" && form !== "huizi_cat_close") continue;
                const progress = Z.v239HarmlessProgress.get(other) || { count: 0, lastDirection: "" };
                if (!progress.count) {
                    if (candidate.direction !== "zhuangzhou") continue;
                    progress.count = 1;
                    progress.lastDirection = candidate.direction;
                } else if (progress.lastDirection !== candidate.direction) {
                    progress.count++;
                    progress.lastDirection = candidate.direction;
                }
                Z.v239HarmlessProgress.set(other, progress);
                if (progress.count < Math.max(3, Z.v239NoDamageUsesRequired)) continue;
                // 只在庄周再次无伤用牌时开启第一张削灰图，避免首张猫图被同一事件挤掉。
                if (candidate.direction !== "zhuangzhou") continue;
                Z.v239HarmlessProgress.delete(other);
            }
            const step = Z.v239NextStep(state, candidate.direction);
            if (!step || step === state?.step) continue;
            Z.v239DuelStates.set(other, { step });
            const imageId = Z.v239StepArt(step);
            const from = Z.v220CurrentId(other);
            if (imageId && from !== imageId && Z.v220ApplyVisual(other, imageId)) {
                Z.v226RecordTransformation(other, { from, to: imageId });
            }
        }
    };
    // 已进入虎威／削灰后仍遵守受伤时猫图优先；两张原始惠子图不由伤害触发变化。
    Z.v239OnHuiziDamaged = target => {
        if (!Z.v239Eligible(target)) return null;
        return Z.v239ResetToCat(target, true);
    };
    Z.v215ManualImage = player => {
        const baseId = Z.v215ManualImagery.get(player);
        let id = baseId;
        if (["fish", "grilled_fish"].includes(baseId) &&
            ["grilled_fish", "burnt_fish"].includes(Z.v220PersistentForms.get(player))) {
            id = Z.v220PersistentForms.get(player);
        }
        return Z.v287GrilledImage(player, Z.v215ImageryPool.find(item => item.id === id));
    };
    // V2.7.26：梦境新闻流只存在本次闭眼，原生 game.log 仍完整执行，睁眼恢复原生战报。
    // 不向梦报输出牌点数、花色、剩余体力、真实武将名或任何未公开身份信息。
    // V2.7.31: xd_zhuangzhou_engine can see the very same global damageEnd from more than
    // one global-skill invocation. Identity dedup only: never merge two actual damage events.
    Z.v230SeenDamageEvents = new WeakSet();
    Z.v226DreamReportActive = false;
    Z.v226DreamLines = [];
    Z.v226DreamHost = null;
    Z.v226DreamList = null;
    Z.v226SeenUses = new WeakSet();
    Z.v226PlayerName = player => {
        if (player === game.me) return "庄周";
        return Z.v215ImageryMap.get(player)?.name || Z.v215ManualImage?.(player)?.name || "梦中人";
    };
    Z.v226ImageryName = id => Z.v220Lookup(id)?.name || "梦中人";
    Z.v226Escape = text => String(text == null ? "" : text)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    Z.v226NameHTML = name => '<span class="xd-zz-v226-name">' + Z.v226Escape(name) + '</span>';
    Z.v226PlayerHTML = player => Z.v226NameHTML(Z.v226PlayerName(player));
    Z.v226ImageryHTML = id => Z.v226NameHTML(Z.v226ImageryName(id));
    // V2.7.36：梦报最新消息置顶，其余正文和人物名称着色规则不变。
    Z.v226AddDreamLine = (message, html) => {
        if (!Z.v226DreamReportActive || !Z.blind(game.me) || !message) return;
        const payload = { text: String(message), html: html ? String(html) : "" };
        Z.v226DreamLines.unshift(payload);
        // 本次闭眼的新闻完整保留；旧消息只在睁眼时清空，过多时由列表独立滚动。
        if (!Z.v226DreamList) return;
        const line = document.createElement("div");
        line.className = "xd-zz-v226-line xd-zz-v237-ink-arrive";
        if (payload.html) line.innerHTML = payload.html;
        else line.textContent = payload.text;
        // 和本体战报一致：最新消息永远占第一行，旧消息向下推。
        Z.v226DreamList.prepend(line);
        // 展开或收起都不丢失旧消息，最新消息保持置顶。
        Z.v226DreamList.scrollTop = 0;
    };
    Z.v226EnsureReportCSS = () => {
        if (document.getElementById("xd-zz-v226-report-css")) return;
        const style = document.createElement("style");
        style.id = "xd-zz-v226-report-css";
        style.textContent = `
            /* 只隐藏本地可见的原生战报与战报历史入口；原生游戏事件和日志照常记录。 */
            .xd-zz-v226-blind #log,
            .xd-zz-v226-blind #arenalog,
            .xd-zz-v226-blind #sidebar3,
            .xd-zz-v226-blind #historybar,
            .xd-zz-v226-blind .historybar,
            .xd-zz-v226-native-hidden {visibility:hidden!important;pointer-events:none!important;}
            /* V2.8.2：保留文字类技能宣告（normal-font），仅遮掉伤害/回复数字浮层。 */
            .xd-zz-v226-blind .player .damage:not(.normal-font) {
                visibility:hidden!important;pointer-events:none!important;
            }
            /* 判定牌属于闭眼不可知的视觉信息：整张展示牌隐藏，但真实判定事件与牌对象不动。 */
            .xd-zz-v226-blind .card.thrownhighlight:not(.xd-zz-v309-heard),
            .xd-zz-v226-blind .card.thrownhighlight:not(.xd-zz-v309-heard) *,
            .xd-zz-v226-blind .card.xd-zz-v299-judge-card,
            .xd-zz-v226-blind .card.xd-zz-v299-judge-card *,
            .xd-zz-v226-blind .xd-zz-v299-judge-dialog,
            .xd-zz-v226-blind .xd-zz-v299-judge-dialog * {
                /* 子节点显式 visibility:visible 也不能穿透父层透明度。 */
                opacity:0!important;visibility:hidden!important;pointer-events:none!important;
            }
            /* 普通正在结算/飞出的牌可以知道牌名，但闭眼不显示花色与点数。 */
            .xd-zz-v226-blind .card.thrown:not(.thrownhighlight) .info,
            .xd-zz-v226-blind .card.thrown:not(.thrownhighlight) .name2,
            .xd-zz-v226-blind .card.thrown.xd-zz-v309-heard .info,
            .xd-zz-v226-blind .card.thrown.xd-zz-v309-heard .name2 {
                visibility:hidden!important;pointer-events:none!important;
            }
            /* 未口述的自行装备、火攻代价牌不向闭眼本机展示；仅标记动画副本。 */
            .xd-zz-v226-blind .card.xd-zz-v297-unspoken-card,
            .xd-zz-v226-blind .card.xd-zz-v297-unspoken-card *,
            .xd-zz-v226-blind .card.xd-zz-v310-folded,
            .xd-zz-v226-blind .card.xd-zz-v310-folded *,
            .xd-zz-v226-blind .player .equips,
            .xd-zz-v226-blind .player .equips *,
            .xd-zz-v226-blind .player .judges,
            .xd-zz-v226-blind .player .judges * {
                visibility:hidden!important;pointer-events:none!important;
            }
            /* v309：盖了牌背的副本上，本体用内联 important 显示的说明条（如“X 过河拆桥”）、转化牌名也一并不显示。 */
            .card.xd-zz-v309-veiled > .cardsetion,
            .card.xd-zz-v309-veiled > .tempname,
            .xd-zz-v226-blind .card.xd-zz-v309-heard > .tempname,
            .xd-zz-v226-blind .card.xd-zz-v309-heard > .initmask,
            .xd-zz-v226-blind .card.xd-zz-v310-declared > .cardsetion {
                visibility:hidden!important;
            }
            /* 角色已死时，真实武将框继续照常进入 game.dead，只在庄周本地隐藏其阵亡视觉。 */
            .player.xd-zz-v282-dead-source-hidden,
            .player.xd-zz-v282-dead-source-hidden * {
                visibility:hidden!important;pointer-events:none!important;
            }
            /* 仅庄周本人的装备区：闭眼只在视觉上遮蔽，真实装备卡与结算不动。 */
            .xd-zz-v226-blind .player.xd-zz-v227-own-blind .equips,
            .xd-zz-v226-blind .player.xd-zz-v227-own-blind .equip,
            .xd-zz-v226-blind #me .equips,
            .xd-zz-v226-blind #me .equip,
            .xd-zz-v226-blind .xd-zz-v227-own-equips-hidden {
                visibility:hidden!important;pointer-events:none!important;
            }
            /* v305：闭眼手选弃牌时，本人装备区的牌可以直接点（真实牌透明，上面盖原生牌背）。
               只放开牌本身；空栏位、栏位名等其他内容仍然隐藏。 */
            html.xd-zz-v226-blind.xd-zz-v305-equip-pick .player.xd-zz-v227-own-blind .equips .card,
            html.xd-zz-v226-blind.xd-zz-v305-equip-pick #me .equips .card,
            html.xd-zz-v226-blind.xd-zz-v305-equip-pick #me .equip .card,
            html.xd-zz-v226-blind.xd-zz-v305-equip-pick #me .equips .card.equip,
            html.xd-zz-v226-blind.xd-zz-v305-equip-pick .xd-zz-v227-own-equips-hidden .card {
                visibility:visible!important;pointer-events:auto!important;
            }
        `;
        document.head.appendChild(style);
    };
    Z.v226HideNativeReport = hidden => {
        document.documentElement.classList.toggle("xd-zz-v226-blind", hidden);
        Z.v309SyncBlindState?.(hidden);
        // 一些无名杀主题的原生日志节点没有固定 ID，优先同时处理公开的 ui 引用。
        for (const node of [ui?.log, ui?.historybar]) {
            node?.classList?.toggle?.("xd-zz-v226-native-hidden", hidden);
        }
    };
    // 部分主题把本人装备区挂在 player.node.equips，另一些放在 #me 下。
    // 双重遮蔽只改本地节点的外观；不删除卡牌、不改 player.getCards('e')。
    Z.v227OwnEquipNodes = new Set();
    Z.v227SyncOwnEquipMask = () => {
        if (typeof document === "undefined") return;
        const active = !!(Z.v2proto && Z.local(game.me) && Z.blind(game.me) &&
            Z.v226DreamReportActive && !Z.ended);
        game.me?.classList?.toggle?.("xd-zz-v227-own-blind", active);
        const candidates = active ? [
            game.me?.node?.equips,
            ui?.me?.querySelector?.(".equips"),
            // 只处理确认位于本人的 #me 面板内的额外装备栏。
            ui?.equip && ui?.me?.contains?.(ui.equip) ? ui.equip : null,
        ].filter(Boolean) : [];
        const next = new Set(candidates);
        for (const node of Z.v227OwnEquipNodes) {
            if (!next.has(node)) node?.classList?.remove?.("xd-zz-v227-own-equips-hidden");
        }
        for (const node of next) node?.classList?.add?.("xd-zz-v227-own-equips-hidden");
        Z.v227OwnEquipNodes = next;
    };
    // 梦闻 UI：新闻随内容增高，较多时单独滚动；边缘渐隐背景保留文字对比度。
    // 手动收起仅改变本地 UI，不影响记录、原生事件或其它玩家。
    // V2.7.x：仅用 CSS 处理“左上清楚、右下渐隐”的阅读邀请态。
    // 鼠标进入新闻列表或标题栏即完整恢复；不增加逐帧任务和图片解码。
    Z.v226MakeDreamHost = () => {
        const host = document.createElement("div");
        host.className = "xd-zz-v226-dream-host";
        const shadow = host.attachShadow({ mode: "open" });
        const style = document.createElement("style");
        style.textContent = `
            :host {all:initial!important;position:fixed!important;top:33vh!important;left:53vw!important;
                width:min(26vw,365px)!important;max-height:min(43vh,390px)!important;z-index:2147481000!important;
                display:block!important;pointer-events:none!important;font:13px/1.55 "Microsoft YaHei","Noto Sans CJK SC",sans-serif!important;}
            *,*::before,*::after {box-sizing:border-box!important;}
            .xd-zz-v226-panel {width:100%!important;max-height:min(43vh,390px)!important;overflow:hidden!important;
                padding:8px 12px 10px!important;border:0!important;border-left:2px solid rgba(213,194,153,.8)!important;
                border-radius:7px 12px 12px 7px!important;
                background:linear-gradient(90deg,rgba(20,30,36,.93) 0%,rgba(20,30,36,.88) 58%,
                    rgba(20,30,36,.74) 82%,rgba(20,30,36,.50) 100%)!important;
                box-shadow:0 5px 16px rgba(0,0,0,.13)!important;
                color:#f5f0e3!important;display:flex!important;flex-direction:column!important;gap:5px!important;}
            .xd-zz-v226-heading {display:flex!important;align-items:center!important;justify-content:space-between!important;
                min-height:26px!important;gap:8px!important;border-bottom:0!important;padding-bottom:4px!important;
                pointer-events:auto!important;}
            .xd-zz-v226-title {font:bold 12px/1.5 serif!important;color:#f0d9a8!important;letter-spacing:.14em!important;}
            /* 上下箭头共用同一按钮尺寸、同一 SVG 视口和相同的几何中心。 */
            .xd-zz-v226-toggle {appearance:none!important;pointer-events:auto!important;cursor:pointer!important;
                display:grid!important;place-items:center!important;flex:0 0 26px!important;
                width:26px!important;height:26px!important;min-width:26px!important;min-height:26px!important;
                border:0!important;border-radius:0!important;box-shadow:none!important;
                background:transparent!important;color:#f0dfbf!important;padding:0!important;}
            .xd-zz-v226-toggle svg {display:block!important;width:18px!important;height:18px!important;overflow:visible!important;}
            .xd-zz-v226-toggle path {fill:none!important;stroke:currentColor!important;stroke-width:2.2!important;
                stroke-linecap:round!important;stroke-linejoin:round!important;}
            .xd-zz-v226-toggle:hover,.xd-zz-v226-toggle:focus-visible {
                background:transparent!important;outline:none!important;color:#ffffff!important;}
            .xd-zz-v226-list {overflow-x:hidden!important;overflow-y:auto!important;
                max-height:calc(min(43vh,390px) - 55px)!important;min-height:0!important;
                display:flex!important;flex:0 1 auto!important;flex-direction:column!important;
                justify-content:flex-start!important;gap:3px!important;scrollbar-width:thin!important;
                pointer-events:auto!important;}
            .xd-zz-v226-line {flex:0 0 auto!important;font:13px/1.45 "Microsoft YaHei","Noto Sans CJK SC",sans-serif!important;
                color:#fffaf0!important;overflow-wrap:anywhere!important;white-space:normal!important;
                text-shadow:0 1px 2px rgba(0,0,0,.6)!important;
                padding:1px 3px!important;border-radius:3px!important;
                background:linear-gradient(90deg,rgba(13,23,30,.22),rgba(13,23,30,0) 96%)!important;}
            /* 未注视时：标题与第一条仍可读；旧新闻越往下越淡，同一行越往右越淡。
               仅改变本地合成/透明度，不重排消息、不修改对局日志。 */
            :host(:not(:hover):not(.xd-zz-v226-collapsed)) .xd-zz-v226-panel {
                background:radial-gradient(ellipse 115% 140% at 0% 0%,
                    rgba(20,30,36,.75) 0%,rgba(20,30,36,.35) 20%,
                    rgba(20,30,36,.07) 47%,rgba(20,30,36,0) 75%)!important;
                box-shadow:0 3px 10px rgba(0,0,0,.07)!important;
            }
            /* 第一条即最新事件。即使右侧是较亮壁纸，也保留可读的暗衬。 */
            :host(:not(:hover):not(.xd-zz-v226-collapsed)) .xd-zz-v226-line:first-child {
                background:linear-gradient(90deg,rgba(13,23,30,.58),rgba(13,23,30,.42) 75%,
                    rgba(13,23,30,.29) 100%)!important;
            }
            /* 旧消息同时受行透明度与水平方向的静态渐隐影响：左侧衰减较慢。 */
            :host(:not(:hover):not(.xd-zz-v226-collapsed)) .xd-zz-v226-line:not(:first-child) {
                -webkit-mask-image:linear-gradient(90deg,#000 0%,rgba(0,0,0,.72) 16%,
                    rgba(0,0,0,.14) 48%,rgba(0,0,0,0) 78%)!important;
                mask-image:linear-gradient(90deg,#000 0%,rgba(0,0,0,.72) 16%,
                    rgba(0,0,0,.14) 48%,rgba(0,0,0,0) 78%)!important;
            }
            :host(:not(:hover):not(.xd-zz-v226-collapsed)) .xd-zz-v226-line:nth-child(2) {opacity:.66!important;}
            :host(:not(:hover):not(.xd-zz-v226-collapsed)) .xd-zz-v226-line:nth-child(3) {opacity:.45!important;}
            :host(:not(:hover):not(.xd-zz-v226-collapsed)) .xd-zz-v226-line:nth-child(4) {opacity:.29!important;}
            :host(:not(:hover):not(.xd-zz-v226-collapsed)) .xd-zz-v226-line:nth-child(5) {opacity:.17!important;}
            :host(:not(:hover):not(.xd-zz-v226-collapsed)) .xd-zz-v226-line:nth-child(6) {opacity:.10!important;}
            :host(:not(:hover):not(.xd-zz-v226-collapsed)) .xd-zz-v226-line:nth-child(7) {opacity:.07!important;}
            :host(:not(:hover):not(.xd-zz-v226-collapsed)) .xd-zz-v226-line:nth-child(n+8) {opacity:.04!important;}
            /* 列表和标题栏已有可命中区，二者的 hover 都能使宿主 :hover 成立。
               恢复原有实色背景和文字，无鼠标追踪、持续动画或额外事件监听。 */
            .xd-zz-v226-name {color:#a7dcff!important;font-weight:700!important;}
            /* 只让最新消息短暂出现；旧消息不反复动画。 */
            .xd-zz-v237-ink-arrive {animation:xd-zz-v237-news-ink .42s cubic-bezier(.2,.7,.25,1) both!important;}
            @keyframes xd-zz-v237-news-ink {
                from {opacity:0;transform:translateY(-6px);filter:blur(1.2px);}
                60% {opacity:.95;filter:blur(0);}
                to {opacity:1;transform:translateY(0);filter:none;}
            }
            /* 折叠时宿主仍占原宽度，窄标签靠右：箭头的屏幕横坐标保持不变。 */
            :host(.xd-zz-v226-collapsed) {width:min(26vw,365px)!important;max-width:none!important;}
            :host(.xd-zz-v226-collapsed) .xd-zz-v226-panel {
                width:max-content!important;margin-left:auto!important;padding:8px 12px 8px!important;
                background:rgba(20,30,36,.9)!important;border-radius:6px!important;
                box-shadow:0 3px 10px rgba(0,0,0,.16)!important;}
            :host(.xd-zz-v226-collapsed) .xd-zz-v226-heading {border-bottom:0!important;padding-bottom:4px!important;}
            :host(.xd-zz-v226-collapsed) .xd-zz-v226-list {display:none!important;}
            @media(prefers-reduced-motion:reduce) {.xd-zz-v237-ink-arrive {animation:none!important;}}
            @media(max-width:900px) {:host {left:49vw!important;width:min(35vw,330px)!important;top:36vh!important;}
                :host(.xd-zz-v226-collapsed) {width:min(35vw,330px)!important;}}
            @media(max-width:570px) {:host {left:auto!important;right:10px!important;width:210px!important;top:30vh!important;}
                :host(.xd-zz-v226-collapsed) {width:210px!important;max-width:210px!important;}}
        `;
        const panel = document.createElement("section");
        panel.className = "xd-zz-v226-panel";
        panel.setAttribute("aria-label", "庄周梦境战报");
        const heading = document.createElement("div");
        heading.className = "xd-zz-v226-heading";
        const title = document.createElement("div");
        title.className = "xd-zz-v226-title";
        title.textContent = "梦闻";
        const toggle = document.createElement("button");
        toggle.className = "xd-zz-v226-toggle";
        toggle.type = "button";
        const chevronNS = "http://www.w3.org/2000/svg";
        const toggleIcon = document.createElementNS(chevronNS, "svg");
        toggleIcon.setAttribute("viewBox", "0 0 24 22");
        toggleIcon.setAttribute("aria-hidden", "true");
        const togglePath = document.createElementNS(chevronNS, "path");
        togglePath.setAttribute("d", "M4.5 14.5 L12 7 L19.5 14.5");
        toggleIcon.appendChild(togglePath);
        toggle.appendChild(toggleIcon);
        toggle.setAttribute("aria-label", "收起梦闻");
        toggle.setAttribute("aria-expanded", "true");
        const list = document.createElement("div");
        list.className = "xd-zz-v226-list";
        list.id = "xd-zz-v226-news-list";
        toggle.setAttribute("aria-controls", list.id);
        list.setAttribute("aria-live", "polite");
        list.setAttribute("aria-relevant", "additions");
        // 新闻较多时允许独立滚动，禁止把面板手势传播成对局操作。
        list.addEventListener("pointerdown", event => event.stopPropagation());
        list.addEventListener("click", event => event.stopPropagation());
        list.addEventListener("wheel", event => event.stopPropagation(), { passive: true });
        // 只有收起按钮和新闻列表接收操作，面板其余区域不阻挡出牌。
        toggle.addEventListener("pointerdown", event => event.stopPropagation());
        toggle.addEventListener("click", event => {
            event.stopPropagation();
            const collapsed = host.classList.toggle("xd-zz-v226-collapsed");
            togglePath.setAttribute("d", collapsed
                ? "M4.5 7 L12 14.5 L19.5 7"
                : "M4.5 14.5 L12 7 L19.5 14.5");
            toggle.setAttribute("aria-expanded", String(!collapsed));
            toggle.setAttribute("aria-label", (collapsed ? "展开" : "收起") + "梦闻");
            if (!collapsed) list.scrollTop = 0;
        });
        heading.append(title,toggle);
        panel.append(heading,list);
        shadow.append(style,panel);
        document.body.appendChild(host);
        Z.v226DreamHost = host;
        Z.v226DreamList = list;
    };
    // logSkill 的原生公开口述通常经 game.log 输出；只截取“发动了【技能】”这类公开声明。
    // 未被口述的强制／隐藏／内部辅助技能一律不从技能事件中猜测并补写。
    Z.v226HookPublicSkillLogs = () => {
        if (Z.v226WrappedLog || typeof game.log !== "function") return;
        const original = game.log;
        const wrapped = function (...args) {
            if (Z.v226DreamReportActive && Z.blind(game.me)) {
                try {
                    const speaker = args.find(value => (game.players || []).includes(value) ||
                        (game.dead || []).includes(value));
                    const utterance = args.filter(value => typeof value === "string")
                        .join("").replace(/#[a-z]/gi, "").replace(/<[^>]*>/g, "");
                    if (speaker && utterance.includes("发动了")) {
                        const bracketed = utterance.match(/【([^】]{1,40})】/);
                        const index = args.findIndex(value => typeof value === "string" && value.includes("发动了"));
                        // 兼容本体 game.log(player, "发动了", "#g技能名") 的公开口述格式。
                        const next = index >= 0 ? args.slice(index + 1).find(value => typeof value === "string") : "";
                        const plain = String(next || "").replace(/^#[a-z]/gi, "").replace(/[【】]/g, "").trim();
                        const skillName = bracketed?.[1] || (plain.length <= 20 ? plain : "");
                        if (skillName && !/[\r\n<>]/.test(skillName)) Z.v226AddDreamLine(
                            Z.v226PlayerName(speaker) + "发动了【" + skillName + "】。"
                        );
                    }
                } catch (e) { /* 战报附加层不得干扰本体 log */ }
            }
            return original.apply(this,args);
        };
        game.log = wrapped;
        Z.v226WrappedLog = wrapped;
    };
    Z.v226StartDreamReport = () => {
        if (Z.v226DreamReportActive || !Z.local(game.me) || !Z.blind(game.me) || typeof document === "undefined") return;
        Z.v226DreamReportActive = true;
        Z.v226DreamLines = [];
        Z.v226SeenUses = new WeakSet();
        Z.v230SeenDamageEvents = new WeakSet();
        Z.v226EnsureReportCSS();
        Z.v226HideNativeReport(true);
        Z.v227SyncOwnEquipMask();
        Z.v226MakeDreamHost();
        Z.v226HookPublicSkillLogs();
    };
    Z.v226StopDreamReport = () => {
        Z.v226DreamReportActive = false;
        Z.v226DreamLines.length = 0;
        Z.v226SeenUses = new WeakSet();
        try { Z.v226DreamHost?.remove(); } catch (e) {}
        Z.v226DreamHost = null;
        Z.v226DreamList = null;
        if (typeof document !== "undefined") {
            Z.v226HideNativeReport(false);
            Z.v227SyncOwnEquipMask();
        }
    };
    Z.v226SyncDreamReport = () => {
        if (!Z.local(game.me) || !Z.blind(game.me) || Z.ended || !Z.v215ImageryActive) {
            if (Z.v226DreamReportActive) Z.v226StopDreamReport();
            return;
        }
        if (!Z.v226DreamReportActive) Z.v226StartDreamReport();
        else if (Z.v226DreamHost?.isConnected) Z.v226HideNativeReport(true);
        Z.v227SyncOwnEquipMask();
    };
    Z.v226RecordUseCard = event => {
        if (!Z.v226DreamReportActive || !Z.blind(game.me) || !event?.card || !event.player) return;
        if (Z.v226SeenUses.has(event)) return;
        Z.v226SeenUses.add(event);
        const source = event.player;
        // 对自己使用装备没有口头宣告；不把本体 useCard 事件自动变成梦闻。
        if (source !== game.me && Z.v297SelfEquipUse?.(event, source)) return;
        const targets = [...new Set((event.targets || []).filter(target => target && target !== source))];
        const who = Z.v226PlayerName(source);
        const whoHTML = Z.v226PlayerHTML(source);
        const targetsText = targets.map(target => Z.v226PlayerName(target)).join("、");
        const targetsHTML = targets.map(target => Z.v226PlayerHTML(target)).join("、");
        if (source === game.me && Z.blind(source)) {
            // 庄周自己的闭眼盲用成功：只知道使用了牌和自己指定的目标。
            // 尤其不许因为用牌无需指定目标，就在梦报里泄露它是装备牌。
            Z.v226AddDreamLine(targets.length
                ? who + "对" + targetsText + "使用了一张牌。"
                : who + "未指定目标使用了一张牌。",
                targets.length ? whoHTML + "对" + targetsHTML + "使用了一张牌。" : whoHTML + "未指定目标使用了一张牌。"
            );
            return;
        }
        const name = get.name(event.card, source) || event.card.name;
        if (!name) return;
        const cardName = String(get.translation(name) || name);
        const safeCard = Z.v226Escape(cardName);
        Z.v226AddDreamLine(targets.length
            ? who + "对" + targetsText + "使用了【" + cardName + "】。"
            : who + "使用了【" + cardName + "】。",
            targets.length
                ? whoHTML + "对" + targetsHTML + "使用了【" + safeCard + "】。"
                : whoHTML + "使用了【" + safeCard + "】。"
        );
    };
    // v309：打出的牌同样会被口述。其他角色写牌名；庄周自己只写“打出了一张牌”；改判（高亮打出）不写。
    Z.v309SeenResponds = new WeakSet();
    Z.v309RecordRespond = event => {
        if (!Z.v226DreamReportActive || !Z.blind(game.me) || !event?.player || event.highlight) return;
        if (Z.v309SeenResponds.has(event)) return;
        Z.v309SeenResponds.add(event);
        const source = event.player;
        const who = Z.v226PlayerName(source);
        const whoHTML = Z.v226PlayerHTML(source);
        if (source === game.me) {
            Z.v226AddDreamLine(who + "打出了一张牌。", whoHTML + "打出了一张牌。");
            return;
        }
        const name = event.card ? (get.name(event.card, source) || event.card.name) : "";
        if (!name) return;
        const cardName = String(get.translation(name) || name);
        Z.v226AddDreamLine(who + "打出了【" + cardName + "】。", whoHTML + "打出了【" + Z.v226Escape(cardName) + "】。");
    };
    Z.v226RecordTransformation = (target, transition) => {
        if (!transition) return;
        const from = Z.v226ImageryName(transition.from);
        const to = Z.v226ImageryName(transition.to);
        // 特殊视觉变化在本地报道；真正的目标、伤害信息只由已发生的公共事件产生。
        Z.v226AddDreamLine(from + "变成了" + to + "。",
            Z.v226ImageryHTML(transition.from) + "变成了" + Z.v226ImageryHTML(transition.to) + "。");
    };
    // 伤害与扣血本身没有口头宣告，不进入梦闻；已约定的角色形象变化仍正常触发。
    // Only record and transform once for the exact same completed damage event.
    // WeakSet preserves separate damageEnd events (even same victim / same amount).
    Z.v230HandleDamageEnd = damage => {
        if (!damage || typeof damage !== "object" || !(damage.num > 0) ||
            !Z.v215ImageryActive || !Z.local(game.me) || !Z.blind(game.me) ||
            Z.v230SeenDamageEvents.has(damage)) return false;
        Z.v230SeenDamageEvents.add(damage);
        if (damage.player && damage.player !== game.me) {
            Z.v226RecordTransformation(damage.player, Z.v239OnHuiziDamaged(damage.player));
            Z.v226RecordTransformation(damage.player, Z.v220OnDamaged(damage.player, damage));
        }
        return true;
    };

    Z.v215AssignImagery = players => {
        const pool = Z.v215Shuffle(Z.v219RandomPool);
        const fixed = new Set();
        const free = [];
        for (const player of players) {
            const pinned = Z.v215ManualImage(player);
            if (pinned) {
                Z.v215ImageryMap.set(player, pinned);
                fixed.add(pinned.id);
            } else free.push(player);
        }
        // 未标记的角色照旧重新抽签。已固定的意象不参与普通随机分配。
        // 用增广路径匹配，意象池足够时仍保证未标记角色互不重复，且避开上次意象。
        const available = pool.filter(item => !fixed.has(item.id));
        const ownerById = new Map();
        const assigned = new Map();
        const assign = (player, seen) => {
            for (const image of Z.v215Shuffle(available)) {
                if (image.id === Z.v215PreviousMap.get(player)?.id || seen.has(image.id)) continue;
                seen.add(image.id);
                const owner = ownerById.get(image.id);
                if (!owner || assign(owner, seen)) {
                    ownerById.set(image.id, player);
                    assigned.set(player, image);
                    return true;
                }
            }
            return false;
        };
        for (const player of Z.v215Shuffle(free)) assign(player, new Set());
        free.forEach((player, index) => {
            let image = assigned.get(player);
            if (!image) {
                const remaining = available.filter(item =>
                    !Array.from(Z.v215ImageryMap.values()).concat(Array.from(assigned.values()))
                        .some(used => used.id === item.id)
                );
                image = Z.v215Shuffle(remaining)[0];
            }
            if (!image) {
                // 超过意象池容量时允许重复意象；各角色仍由 player 对象分别映射，牌面不显示编号。
                const source = pool[index % pool.length];
                image = { ...source, name: source.name };
            }
            Z.v215ImageryMap.set(player, image);
        });
    };
    Z.v215BeginImagery = player => {
        if (!Z.local(player) || !Z.blind(player) || Z.v215ImageryActive) return;
        Z.v237ClearLeaving?.();
        Z.v237ClearCurtain?.();
        Z.v215RemoveOverlays();
        Z.v215ImageryMap.clear();
        Z.v239DuelStates.clear();
        Z.v239HarmlessProgress.clear();
        Z.v239CatForms.clear();
        Z.v239CatLocked.clear();
        Z.v239CandidateUses = new WeakMap();
        Z.v239FinishedUses = new WeakSet();
        Z.v215ImageryActive = true;
        const dreamSeats = Array.from(new Set([...(game.players || []), ...(game.dead || [])]))
            .filter(p => p && p !== player);
        Z.v282SnapshotDreamSeatSizes?.(dreamSeats);
        Z.v215AssignImagery(dreamSeats);
        Z.v241BeginDreamWallpaper?.();
        Z.v215SyncImagery(player);
        Z.v237PlayCurtain?.("enter");
        Z.v226StartDreamReport?.();
    };
    Z.v215GetImagery = player => {
        let image = Z.v215ImageryMap.get(player);
        if (image) return image;
        image = Z.v215ManualImage(player);
        if (!image) {
            const used = new Set(Array.from(Z.v215ImageryMap.values(), item => item.id));
            const candidates = Z.v219RandomPool.filter(item => !used.has(item.id) &&
                item.id !== Z.v215PreviousMap.get(player)?.id);
            const fallback = Z.v219RandomPool.filter(item => !used.has(item.id));
            image = Z.v215Shuffle(candidates.length ? candidates : fallback)[0];
            if (!image) {
                const base = Z.v219RandomPool[Z.v215ImageryMap.size % Z.v219RandomPool.length];
                image = { ...base, name: base.name };
            }
        }
        Z.v215ImageryMap.set(player, image);
        return image;
    };
    Z.v216RefreshOverlayNames = () => {
        Z.v296SyncWuxieDialogs?.();
        // 梦境遮盖牌一律显示意象原名；不同玩家仍由真实 player 对象独立映射和选择。
        for (const [player, record] of Z.v215Overlays) {
            const image = Z.v215ImageryMap.get(player);
            if (!image) continue;
            const label = image.name;
            // 仍可每帧发现新增/替换的角色节点，但未换形象时不再每帧重写整张武将牌 DOM。
            const key = [image.id, label, image.glyph, image.hue, image.art || ""].join("\u0001");
            if (record._xd_zz_renderedKey === key &&
                record.name.textContent === label && record.glyph.textContent === image.glyph &&
                record.art?._xd_zz_art === (image.art || "")) continue;
            record.glyph.textContent = image.glyph;
            record.name.textContent = label;
            record.overlay.style.setProperty("--zz-ink", image.hue);
            Z.v219SyncArt(record.overlay, record.art, image);
            record.edit.setAttribute("aria-label", "更换“" + label + "”的角色形象");
            record.node.setAttribute?.("aria-label", "角色形象·" + label);
            record._xd_zz_renderedKey = key;
        }
    };
    Z.v216RandomizeOne = player => {
        const used = new Set(Array.from(Z.v215ImageryMap, ([other, image]) =>
            other === player ? null : image.id).filter(Boolean));
        const pool = Z.v215Shuffle(Z.v219RandomPool.filter(item => !used.has(item.id)));
        const oldId = Z.v215ImageryMap.get(player)?.id;
        const image = pool.find(item => item.id !== oldId) || pool[0] ||
            Z.v215Shuffle(Z.v219RandomPool.filter(item => item.id !== oldId))[0] ||
            Z.v219RandomPool[0];
        Z.v215ImageryMap.set(player, image);
        return image;
    };
    // V2.8.5：梦境笔记里的“角色”既可能仍存活，也可能已经进入 game.dead。
    // 编辑的只是庄周本地意象映射，因此死者与活人的改标资格一致。
    Z.v285EditableImageryPlayer = player => !!(
        player && player !== game.me &&
        ((game.players || []).includes(player) || (game.dead || []).includes(player))
    );
    Z.v216SetManualImagery = (player, id, art) => {
        if (!Z.v215ImageryActive || !Z.blind(game.me) || !Z.v285EditableImageryPlayer(player)) return;
        const base = Z.v215ImageryPool.find(item => item.id === id);
        if (!base || (id === "grilled_fish" && art && !Z.v287GrilledVariants.some(variant => variant.art === art))) return;
        Z.v287GrilledArts.delete(player);
        const image = Z.v287GrilledImage(player, base, false, art || base.art);
        Z.v220PersistentForms.delete(player);
        Z.v239DuelStates.delete(player); // 玩家手动改标后，旧的往返进度作废。
        Z.v239HarmlessProgress.delete(player);
        Z.v239CatForms.delete(player);
        Z.v239CatLocked.delete(player);
        Z.v215ManualImagery.set(player, image.id);
        Z.v215ImageryMap.set(player, image);
        // 手动占用了另一个随机角色的意象时，只重抽那个随机角色，不动别人的笔记。
        for (const [other, otherImage] of Z.v215ImageryMap) {
            if (other !== player && otherImage.id === image.id && !Z.v215ManualImagery.has(other)) {
                Z.v216RandomizeOne(other);
            }
        }
        Z.v216RefreshOverlayNames();
        if ((game.dead || []).includes(player)) Z.v282EnsureDeadDreamShell?.(player);
    };
    Z.v216ResetManualImagery = player => {
        if (!Z.v215ImageryActive || !Z.blind(game.me) || !Z.v285EditableImageryPlayer(player)) return;
        Z.v215ManualImagery.delete(player);
        Z.v287GrilledArts.delete(player);
        Z.v220PersistentForms.delete(player);
        Z.v239DuelStates.delete(player);
        Z.v239HarmlessProgress.delete(player);
        Z.v239CatForms.delete(player);
        Z.v239CatLocked.delete(player);
        Z.v216RandomizeOne(player);
        Z.v216RefreshOverlayNames();
        if ((game.dead || []).includes(player)) Z.v282EnsureDeadDreamShell?.(player);
    };
    // V2.7.18: isolate the entire optional imagery chooser from global Noname UI CSS.
    // Do not use document.head rules for this modal; the arena has aggressive layout selectors.
    Z.v218ChooserCSS = `
            :host {
                all:initial!important;
                position:fixed!important; inset:0!important; z-index:2147483000!important;
                display:block!important; pointer-events:auto!important;
                font:15px/1.4 Arial,"Noto Sans CJK SC","Microsoft YaHei",sans-serif!important;
                color:#24485c!important; isolation:isolate!important;
            }
            *,*::before,*::after {box-sizing:border-box!important;}
            button,input {font:inherit!important; letter-spacing:normal!important; text-transform:none!important;}
            button {appearance:none!important; -webkit-appearance:none!important; flex-shrink:0!important;}
            .xd-zz-v216-backdrop {width:100%!important;height:100%!important;}
            .xd-zz-v216-backdrop {
                position:fixed!important; inset:0!important; z-index:2147483000!important;
                display:flex!important; align-items:center!important; justify-content:center!important;
                background:rgba(13,34,49,.38)!important; pointer-events:auto!important;
            }
            .xd-zz-v216-palette {
                box-sizing:border-box!important; width:min(760px,94vw)!important;
                height:min(700px,82vh)!important; min-height:0!important;
                display:flex!important; flex-direction:column!important; gap:10px!important;
                overflow:hidden!important; padding:16px!important;
                background:#eef5f8!important; color:#24485c!important;
                border:1px solid #8fb7c4!important; border-radius:14px!important;
                box-shadow:0 12px 40px rgba(0,0,0,.5)!important;
                font:15px/1.4 sans-serif!important;
            }
            .xd-zz-v216-palette header {display:flex!important;align-items:flex-start!important;justify-content:space-between!important;gap:8px!important;flex:0 0 auto!important;}
            .xd-zz-v216-heading {display:flex!important;flex-direction:column!important;gap:3px!important;}
            .xd-zz-v216-heading strong {font-size:20px!important;letter-spacing:.03em!important;}
            .xd-zz-v216-heading span {font-size:12px!important;opacity:.82!important;}
            .xd-zz-v216-palette header button {font-size:24px!important;padding:0 8px!important;cursor:pointer!important;line-height:1!important;}
            .xd-zz-v216-current {
                display:grid!important; grid-template-columns:120px minmax(0,1fr)!important; gap:12px!important; align-items:center!important;
                padding:10px!important; border-radius:12px!important; background:linear-gradient(135deg,#f7fbfd,#e0edf3)!important;
                border:1px solid #bfd4de!important; flex:0 0 auto!important;
            }
            .xd-zz-v216-current-thumb {
                position:relative!important; height:118px!important; border-radius:12px!important; overflow:hidden!important;
                display:flex!important; align-items:center!important; justify-content:center!important;
                background:linear-gradient(150deg,#f8fcff 0%,#dbeaf1 55%,#cbe0e8 100%)!important;
                border:1px solid rgba(95,146,174,.75)!important; box-shadow:inset 0 0 14px rgba(63,102,136,.15)!important;
            }
            .xd-zz-v216-current-thumb::before {
                content:""; position:absolute; inset:6px; border-radius:10px; border:1px solid rgba(255,255,255,.72);
            }
            .xd-zz-v216-current-glyph {font-size:56px!important; line-height:1!important; font-weight:600!important; color:var(--zz-ink,#548aa4)!important; text-shadow:0 2px 0 #fff,0 0 16px rgba(255,255,255,.75)!important;}
            .xd-zz-v216-current-chip {
                position:absolute!important; right:8px!important; top:8px!important; padding:3px 7px!important; border-radius:999px!important;
                background:rgba(255,255,255,.94)!important; border:1px solid #bdd0d8!important; color:#496777!important; font-size:11px!important; font-weight:700!important;
            }
            .xd-zz-v216-current-meta {display:flex!important; flex-direction:column!important; gap:6px!important; min-width:0!important;}
            .xd-zz-v216-current-title {font-size:18px!important; font-weight:700!important; color:#28485a!important;}
            .xd-zz-v216-current-note {font-size:13px!important; opacity:.84!important;}
            .xd-zz-v216-palette input[type=search] {
                box-sizing:border-box!important; width:100%!important; padding:10px 12px!important; flex:0 0 auto!important;
                border:1px solid #94b5c2!important; border-radius:9px!important; background:white!important; color:#24485c!important;
            }
            .xd-zz-v216-section-title {font-size:14px!important; font-weight:700!important; color:#4b6b7a!important; flex:0 0 auto!important;}
            .xd-zz-v216-scroller {
                flex:1 1 auto!important; min-height:0!important; width:100%!important; overflow:auto!important; padding-right:4px!important;
                border-top:1px solid rgba(148,181,194,.45)!important; border-bottom:1px solid rgba(148,181,194,.45)!important;
            }
            .xd-zz-v216-grid {
                display:grid!important; grid-template-columns:repeat(4,minmax(0,1fr))!important; width:100%!important;
                gap:10px!important; padding:12px 1px!important; align-content:start!important;
            }
            .xd-zz-v216-choice {
                display:flex!important; flex-direction:column!important; gap:8px!important; align-items:stretch!important;
                padding:8px!important; cursor:pointer!important; border-radius:12px!important;
                min-width:0!important; width:100%!important; white-space:normal!important;
                background:#ffffff!important; border:1px solid #b5cdd8!important; color:#2e566a!important; text-align:left!important;
                box-shadow:0 1px 4px rgba(27,65,89,.08)!important;
            }
            .xd-zz-v216-choice:hover {transform:translateY(-1px)!important; box-shadow:0 4px 12px rgba(27,65,89,.14)!important;}
            .xd-zz-v216-choice-thumb {
                position:relative!important; height:124px!important; border-radius:10px!important; overflow:hidden!important;
                display:flex!important; align-items:center!important; justify-content:center!important;
                background:linear-gradient(150deg,#f8fcff 0%,#dbeaf1 55%,#cbe0e8 100%)!important;
                border:1px solid rgba(95,146,174,.68)!important; box-shadow:inset 0 0 14px rgba(63,102,136,.12)!important;
            }
            .xd-zz-v216-choice-thumb::before {content:""; position:absolute; inset:6px; border:1px solid rgba(255,255,255,.72); border-radius:8px;}
            .xd-zz-v216-choice-glyph {font-size:52px!important; line-height:1!important; font-weight:600!important; color:var(--zz-ink,#548aa4)!important; text-shadow:0 2px 0 #fff,0 0 16px rgba(255,255,255,.75)!important;}
            .xd-zz-v216-choice-badge {
                position:absolute!important; right:8px!important; top:8px!important; padding:2px 7px!important; border-radius:999px!important;
                background:rgba(255,255,255,.94)!important; border:1px solid #bdd0d8!important; color:#547180!important; font-size:10px!important; font-weight:700!important;
            }
            .xd-zz-v216-choice-meta {display:flex!important; flex-direction:column!important; gap:3px!important; padding:0 1px 2px!important; min-width:0!important;}
            .xd-zz-v216-choice-title {font-size:16px!important; font-weight:700!important; color:var(--zz-ink,#34596e)!important;}
            .xd-zz-v216-choice-subtitle {font-size:11px!important; opacity:.75!important;}
            .xd-zz-v216-choice.xd-zz-v216-chosen {border:2px solid #489bbc!important; background:#d6edf5!important;}
            .xd-zz-v216-choice[hidden] {display:none!important;}
            .xd-zz-v216-footer {display:flex!important; align-items:center!important; justify-content:space-between!important; gap:10px!important; flex:0 0 auto!important; flex-wrap:wrap!important;}
            .xd-zz-v216-reset {padding:8px 14px!important; cursor:pointer!important; border-radius:8px!important; background:#dde9ed!important; color:#34596e!important; border:1px solid #b5cdd8!important;}
            .xd-zz-v216-footer-note {font-size:12px!important; opacity:.78!important;}

            .xd-zz-v216-current-thumb .xd-zz-v219-art,
            .xd-zz-v216-choice-thumb .xd-zz-v219-art {
                position:absolute!important; inset:0!important; width:100%!important; height:100%!important;
                object-fit:contain!important; object-position:center center!important;
                pointer-events:none!important; border-radius:inherit!important;
            }
            .xd-zz-v216-current-thumb.xd-zz-v219-has-art,
            .xd-zz-v216-choice-thumb.xd-zz-v219-has-art {background:transparent!important; box-shadow:none!important;}
            .xd-zz-v216-current-thumb.xd-zz-v219-has-art .xd-zz-v216-current-glyph,
            .xd-zz-v216-choice-thumb.xd-zz-v219-has-art .xd-zz-v216-choice-glyph {display:none!important;}
            .xd-zz-v216-current-chip,.xd-zz-v216-choice-badge {z-index:2!important;}
            .xd-zz-v216-current-thumb::before,.xd-zz-v216-choice-thumb::before {z-index:1!important; pointer-events:none!important;}
            .xd-zz-v219-art[hidden] {display:none!important;}
            @media (max-width:740px) {
                .xd-zz-v216-grid {grid-template-columns:repeat(3,minmax(0,1fr))!important;}
                .xd-zz-v216-current {grid-template-columns:86px minmax(0,1fr)!important;}
                .xd-zz-v216-current-thumb {height:86px!important;}
                .xd-zz-v216-current-glyph {font-size:42px!important;}
            }
            @media (max-width:540px) {
                .xd-zz-v216-grid {grid-template-columns:repeat(2,minmax(0,1fr))!important;}
                .xd-zz-v216-palette {padding:10px!important;gap:7px!important;}
                .xd-zz-v216-choice-thumb {height:90px!important;}
                .xd-zz-v216-current-note,.xd-zz-v216-footer-note {display:none!important;}
                .xd-zz-v216-heading strong {font-size:18px!important;}
            }
            @media (max-height:650px) {
                .xd-zz-v216-current-thumb {height:70px!important;}
                .xd-zz-v216-current-glyph {font-size:36px!important;}
                .xd-zz-v216-choice-thumb {height:95px!important;}
                .xd-zz-v216-palette {height:88vh!important;max-height:88vh!important;}
            }
    `;
    Z.v216OpenChooser = player => {
        if (!Z.v215ImageryActive || !Z.blind(game.me) || !Z.v285EditableImageryPlayer(player)) return;
        const hasDreamSurface = Z.v215Overlays.has(player) || Z.v282DeadDreamShells?.has?.(player);
        if (!hasDreamSurface) return;
        Z.v215CloseChooser();
        const stop = e => { e.stopPropagation(); };
        const host = document.createElement("div");
        host.className = "xd-zz-v218-chooser-host";
        const shadow = host.attachShadow({ mode: "open" });
        const shadowStyle = document.createElement("style");
        shadowStyle.textContent = Z.v218ChooserCSS;
        const backdrop = document.createElement("div");
        backdrop.className = "xd-zz-v216-backdrop";
        shadow.append(shadowStyle, backdrop);
        const panel = document.createElement("section");
        panel.className = "xd-zz-v216-palette";
        panel.setAttribute("role", "dialog");
        panel.setAttribute("aria-label", "更换角色形象");
        const currentImage = Z.v215ImageryMap.get(player) || Z.v215GetImagery(player);
        const manual = Z.v215ManualImagery.has(player);

        const header = document.createElement("header");
        const headingWrap = document.createElement("div");
        headingWrap.className = "xd-zz-v216-heading";
        const heading = document.createElement("strong");
        heading.textContent = "更换角色形象";
        const sub = document.createElement("span");
        sub.textContent = "随机分配后，可由庄周手动改标；本局后续闭眼保留。";
        headingWrap.append(heading, sub);
        const close = document.createElement("button");
        close.type = "button";
        close.textContent = "×";
        close.setAttribute("aria-label", "关闭");
        close.addEventListener("click", e => { stop(e); Z.v215CloseChooser(); });
        header.append(headingWrap, close);

        const current = document.createElement("div");
        current.className = "xd-zz-v216-current";
        current.style.setProperty("--zz-ink", currentImage?.hue || "#5a98b4");
        const currentThumb = document.createElement("div");
        currentThumb.className = "xd-zz-v216-current-thumb";
        const currentGlyph = document.createElement("span");
        currentGlyph.className = "xd-zz-v216-current-glyph";
        currentGlyph.textContent = currentImage?.glyph || "梦";
        const currentChip = document.createElement("span");
        currentChip.className = "xd-zz-v216-current-chip";
        currentChip.textContent = "当前";
        currentThumb.append(Z.v219MakeArt(currentThumb, currentImage), currentGlyph, currentChip);
        const currentMeta = document.createElement("div");
        currentMeta.className = "xd-zz-v216-current-meta";
        const currentTitle = document.createElement("div");
        currentTitle.className = "xd-zz-v216-current-title";
        currentTitle.textContent = (currentImage?.name || "未定") + (manual ? " · 手动标记" : " · 随机分配");
        const currentNote = document.createElement("div");
        currentNote.className = "xd-zz-v216-current-note";
        currentNote.textContent = "点击下方卡片即可立刻替换；整张武将牌仍可正常选目标。";
        currentMeta.append(currentTitle, currentNote);
        current.append(currentThumb, currentMeta);

        const search = document.createElement("input");
        search.type = "search";
        search.placeholder = "搜索角色形象：鱼、惠子、鲲鹏……";
        search.setAttribute("aria-label", "搜索角色形象");

        const sectionTitle = document.createElement("div");
        sectionTitle.className = "xd-zz-v216-section-title";
        sectionTitle.textContent = "选择新的角色形象";

        const scroller = document.createElement("div");
        scroller.className = "xd-zz-v216-scroller";
        const grid = document.createElement("div");
        grid.className = "xd-zz-v216-grid";
        const options = [];
        for (const image of Z.v287ChoiceImages()) {
            const choice = document.createElement("button");
            choice.type = "button";
            choice.className = "xd-zz-v216-choice";
            choice.style.setProperty("--zz-ink", image.hue);
            if (Z.v215ManualImagery.get(player) === image.id &&
                (image.id !== "grilled_fish" || Z.v287GrilledArts.get(player) === image.art)) {
                choice.classList.add("xd-zz-v216-chosen");
            }

            const thumb = document.createElement("div");
            thumb.className = "xd-zz-v216-choice-thumb";
            const glyph = document.createElement("div");
            glyph.className = "xd-zz-v216-choice-glyph";
            glyph.textContent = image.glyph;
            const badge = document.createElement("div");
            badge.className = "xd-zz-v216-choice-badge";
            badge.textContent = "形象";
            thumb.append(Z.v219MakeArt(thumb, image), glyph, badge);

            const meta = document.createElement("div");
            meta.className = "xd-zz-v216-choice-meta";
            const title = document.createElement("div");
            title.className = "xd-zz-v216-choice-title";
            title.textContent = image.choiceName || image.name;
            const subtitle = document.createElement("div");
            subtitle.className = "xd-zz-v216-choice-subtitle";
            subtitle.textContent = image.glyph + " · 点击替换";
            meta.append(title, subtitle);
            choice.append(thumb, meta);

            choice.addEventListener("click", e => {
                stop(e);
                Z.v216SetManualImagery(player, image.id, image.art);
                Z.v215CloseChooser();
            });
            options.push({ image, choice });
            grid.appendChild(choice);
        }
        scroller.appendChild(grid);
        search.addEventListener("input", () => {
            const q = search.value.trim().toLowerCase();
            let visible = 0;
            for (const { image, choice } of options) {
                const hit = !q || (image.choiceName || image.name).toLowerCase().includes(q) || image.id.toLowerCase().includes(q) || image.glyph.toLowerCase().includes(q);
                choice.hidden = !hit;
                if (hit) visible++;
            }
            sectionTitle.textContent = visible ? "选择新的角色形象" : "没有找到匹配的角色形象";
        });

        const footer = document.createElement("div");
        footer.className = "xd-zz-v216-footer";
        const reset = document.createElement("button");
        reset.type = "button";
        reset.className = "xd-zz-v216-reset";
        reset.textContent = "恢复随机分配";
        reset.addEventListener("click", e => {
            stop(e);
            Z.v216ResetManualImagery(player);
            Z.v215CloseChooser();
        });
        const hint = document.createElement("span");
        hint.className = "xd-zz-v216-footer-note";
        hint.textContent = "手动标记会在本局后续闭眼中保留。";
        footer.append(reset, hint);

        panel.append(header, current, search, sectionTitle, scroller, footer);
        backdrop.appendChild(panel);
        for (const eventName of ["pointerdown", "pointerup", "mousedown", "mouseup", "touchstart", "touchend", "click"]) {
            backdrop.addEventListener(eventName, e => {
                if (eventName === "click" && e.target === backdrop) Z.v215CloseChooser();
                stop(e);
            });
        }
        panel.addEventListener("keydown", e => {
            if (e.key === "Escape") { stop(e); Z.v215CloseChooser(); }
            else if (e.key !== "Tab") stop(e);
        });
        // Only the isolated overlay is removed on close; no CSS leaks into the game.
        Z.v215Chooser = host;
        // Shadow DOM events are composed: stop any residual click reaching the arena.
        for (const eventName of ["pointerdown", "pointerup", "mousedown", "mouseup", "touchstart", "touchend", "click"]) {
            host.addEventListener(eventName, e => e.stopPropagation());
        }
        document.body.appendChild(host);
        try { search.focus(); } catch (e) {}
    };
    Z.v215EnsureStyle = () => {
        if (document.getElementById("xd-zz-v215-imagery-style")) return;
        const style = document.createElement("style");
        style.id = "xd-zz-v215-imagery-style";
        style.textContent = `
            /* 只盖住别人真实的武将牌；不改 player DOM 的事件、选择与原生指示线。 */
            /* 某些主题把姓名或体力放在头像盒外，另外隐藏这些原生文本以避免漏出。 */
            .player.xd-zz-v215-masked .name,
            .player.xd-zz-v215-masked .name2,
            .player.xd-zz-v215-masked .hp,
            .player.xd-zz-v215-masked .count,
            .player.xd-zz-v215-masked .identity,
            .player.xd-zz-v215-masked .marks,
            .player.xd-zz-v215-masked .avatar,
            .player.xd-zz-v215-masked .avatar2 { opacity:0!important; }
            /* v309：标记透明后仍能悬停弹出介绍（可能列出武将牌上的牌），闭眼时一并不可悬停。 */
            .player.xd-zz-v215-masked .marks,
            .player.xd-zz-v215-masked .marks * { pointer-events:none!important; }
            /* Only while masked: allow the edit button to project beyond the portrait's top-right corner. */
            .player.xd-zz-v215-masked {overflow:visible!important;}
            .player.xd-zz-v215-masked .xd-zz-v215-veil,
            .xd-zz-v215-masked.player .xd-zz-v215-veil,
            .xd-zz-v237-leavehost .xd-zz-v215-veil,
            .xd-zz-v282-dead-shell .xd-zz-v215-veil {
                position:absolute!important; inset:3px!important; z-index:10000!important;
                display:flex!important; flex-direction:column!important; justify-content:center!important;
                align-items:center!important; gap:2px!important; overflow:visible!important;
                pointer-events:none!important; user-select:none!important; border-radius:8px!important;
                background:linear-gradient(140deg,#f1f7fa 0%,#daeaf0 52%,#c8dfe8 100%)!important;
                border:1px solid rgba(95,146,174,.8)!important;
                color:#28485a!important; box-shadow:inset 0 0 14px rgba(63,102,136,.15)!important;
                font-family:"Noto Serif CJK SC","Songti SC","SimSun",serif!important;
            }
            .xd-zz-v215-veil::before {
                content:""; position:absolute; inset:6px; border:1px solid rgba(255,255,255,.72);
                border-radius:7px; pointer-events:none;
            }
            .xd-zz-v215-glyph {
                font-size:clamp(26px,3.1vw,50px)!important; line-height:1!important;
                font-weight:600!important; color:var(--zz-ink,#548aa4)!important;
                text-shadow:0 2px 0 #fff,0 0 16px rgba(255,255,255,.75)!important;
                white-space:nowrap!important;
            }
            .xd-zz-v215-name {
                padding:1px 4px!important; border-radius:5px!important; background:#f6fafc!important;
                font-size:clamp(11px,1.12vw,16px)!important; line-height:1.25!important;
                font-weight:700!important; letter-spacing:.06em!important; white-space:nowrap!important;
            }
            .xd-zz-v215-veil .xd-zz-v219-art {
                position:absolute!important; inset:0!important; width:100%!important; height:100%!important;
                object-fit:contain!important; object-position:center center!important;
                pointer-events:none!important; border-radius:inherit!important;
            }
            /* V2.7.25: the battlefield veil itself (not the separate chooser) still
               inherited the original cyan 1px border and a 3px inset.  Cover the
               native portrait's colored edge while keeping the external dark rim;
               contain letterboxing, if any, should be dark rather than pale blue. */
            .player.xd-zz-v215-masked .xd-zz-v215-veil.xd-zz-v219-has-art,
            .xd-zz-v215-masked.player .xd-zz-v215-veil.xd-zz-v219-has-art,
            .xd-zz-v237-leavehost .xd-zz-v215-veil.xd-zz-v219-has-art,
            .xd-zz-v282-dead-shell .xd-zz-v215-veil.xd-zz-v219-has-art {
                inset:1px!important;
                border:0!important;
                outline:0!important;
                background:#231d19!important;
                box-shadow:none!important;
            }
            .xd-zz-v215-veil.xd-zz-v219-has-art .xd-zz-v215-glyph {display:none!important;}
            .xd-zz-v215-veil.xd-zz-v219-has-art::before {display:none!important;}
            .xd-zz-v215-veil.xd-zz-v219-has-art .xd-zz-v215-name {
                position:absolute!important; z-index:1!important; bottom:6px!important;
                max-width:calc(100% - 10px)!important; overflow:hidden!important; text-overflow:ellipsis!important;
                padding:2px 6px!important; border:1px solid rgba(134,177,193,.75)!important;
                background:rgba(244,250,253,.95)!important;
                box-shadow:0 1px 4px rgba(18,48,64,.32)!important;
            }
            .xd-zz-v215-veil .xd-zz-v219-art[hidden] {display:none!important;}
            .xd-zz-v215-veil::before {z-index:1!important;}
            .xd-zz-v215-note { font:10px/1.1 sans-serif!important; opacity:.7!important; }
            /* The button straddles the OUTSIDE upper-right edge; the image remains fully available beneath it.
               Only the button itself catches pointer events, so normal portrait selection still works. */
            .xd-zz-v215-veil .xd-zz-v216-edit {
                position:absolute!important; top:-14px!important; right:-14px!important; z-index:3!important;
                pointer-events:auto!important; cursor:pointer!important;
                width:26px!important; height:26px!important; line-height:24px!important;
                padding:0!important; margin:0!important; border:1px solid #729caa!important;
                background:rgba(247,252,255,.97)!important; color:#34596e!important;
                border-radius:7px!important; font:bold 14px sans-serif!important;
                box-shadow:0 1px 4px rgba(10,45,65,.3)!important;
            }


            
            .xd-zz-v219-art {
                opacity:1!important; transform:scale(1)!important; filter:none!important;
                transition:opacity .34s ease, transform .42s cubic-bezier(.22,.61,.36,1), filter .42s ease!important;
                will-change:opacity,transform,filter;
            }
            .xd-zz-v219-art.xd-zz-v219-swapping {
                opacity:0!important; transform:scale(1.04)!important; filter:blur(7px) saturate(1.12)!important;
            }
            .xd-zz-v219-switchfx { position:relative!important; overflow:hidden!important; }
            .xd-zz-v219-switchfx::after {
                content:""; position:absolute; inset:-14%!important; pointer-events:none!important; z-index:2!important;
                background:linear-gradient(115deg, rgba(255,255,255,0) 12%, rgba(255,246,214,.17) 42%, rgba(165,225,255,.33) 50%, rgba(255,246,214,.15) 58%, rgba(255,255,255,0) 86%);
                transform:translateX(-118%) rotate(7deg);
                animation:xd-zz-v219-sheen .56s ease forwards;
                mix-blend-mode:screen;
            }
            @keyframes xd-zz-v219-sheen {
                from { transform:translateX(-118%) rotate(7deg); opacity:0; }
                20% { opacity:.95; }
                to { transform:translateX(118%) rotate(7deg); opacity:0; }
            }
            .avatar.xd-zz-v233-own-butterfly,
            .avatar2.xd-zz-v233-own-butterfly {
                animation:xd-zz-v233-butterfly-breathe 3.2s ease-in-out infinite!important;
                box-shadow:0 0 0 1px rgba(255,244,205,.78), 0 0 10px rgba(120,180,255,.28), 0 0 22px rgba(255,219,140,.22)!important;
                filter:saturate(1.04) brightness(1.03)!important;
            }
            @keyframes xd-zz-v233-butterfly-breathe {
                0%,100% { transform:scale(1); filter:saturate(1.04) brightness(1.03); box-shadow:0 0 0 1px rgba(255,244,205,.78), 0 0 10px rgba(120,180,255,.28), 0 0 22px rgba(255,219,140,.22); }
                50% { transform:scale(1.018); filter:saturate(1.10) brightness(1.08); box-shadow:0 0 0 1px rgba(255,248,220,.92), 0 0 16px rgba(126,190,255,.40), 0 0 28px rgba(255,228,155,.30); }
            }
            /* V2.7.37 – each newly imagined character rises softly out of mist. */
            .player.xd-zz-v215-masked .xd-zz-v215-veil.xd-zz-v237-entering {
                animation:xd-zz-v237-appear .67s cubic-bezier(.19,.72,.28,1) both!important;
            }
            @keyframes xd-zz-v237-appear {
                from {opacity:0;transform:translateY(9px) scale(.955);filter:blur(4px);}
                65% {opacity:.94;filter:blur(.5px);}
                to {opacity:1;transform:translateY(0) scale(1);filter:none;}
            }
            /* These fixed ghosts are inert copies of the old dream cards, not
               actual game players. Original targets are unmasked immediately. */
            .xd-zz-v237-leavehost {
                position:fixed!important;margin:0!important;padding:0!important;
                border:0!important;background:transparent!important;
                transform:none;overflow:visible!important;isolation:isolate!important;
                pointer-events:none!important;user-select:none!important;
                z-index:2147480900!important;
                animation:xd-zz-v237-dissolve .50s ease-in both!important;
            }
            .xd-zz-v237-leavehost .xd-zz-v216-edit {display:none!important;}
            /* 死亡梦境外壳固定在闭眼前的座位中心，不继承真实死者的翻转/上移 transform。 */
            .xd-zz-v282-dead-shell {
                position:fixed!important;margin:0!important;padding:0!important;border:0!important;
                box-sizing:border-box!important;border-radius:8px!important;
                box-shadow:0 0 0 1px rgba(0,0,0,.8),0 2px 6px rgba(0,0,0,.5);
                background:transparent!important;transform:none!important;overflow:visible!important;
                isolation:isolate!important;pointer-events:auto!important;user-select:none!important;
                z-index:2147480900!important;cursor:pointer!important;
            }
            .xd-zz-v282-dead-shell.xd-zz-v2-proto-selected {
                outline:3px solid #9be9ff!important;outline-offset:1px!important;
            }
            /* V2.8.5：阵亡后的梦境外壳仍可改标；复用活人右上角同一枚“换”按钮。 */
            .xd-zz-v282-dead-shell .xd-zz-v216-edit {display:block!important;}
            @keyframes xd-zz-v237-dissolve {
                from {opacity:1;transform:translateY(0) scale(1);filter:blur(0);}
                to {opacity:0;transform:translateY(-7px) scale(1.025);filter:blur(5px);}
            }
            /* One-shot veiled lighting; lower than the isolated edit menu and
               dream news, with pointer-events:none so nothing blocks the arena. */
            .xd-zz-v237-curtain {
                position:fixed!important;inset:0!important;z-index:2147480800!important;
                pointer-events:none!important;user-select:none!important;
                background:radial-gradient(ellipse at 55% 46%,rgba(179,217,255,.28),transparent 62%),
                    linear-gradient(125deg,rgba(255,243,216,.15),rgba(117,164,232,.10),rgba(251,227,211,.09));
                opacity:0;mix-blend-mode:screen;
            }
            .xd-zz-v237-curtain-enter {
                animation:xd-zz-v237-curtain-in .74s ease-in-out both!important;
            }
            .xd-zz-v237-curtain-exit {
                animation:xd-zz-v237-curtain-out .58s ease-in-out both!important;
            }
            @keyframes xd-zz-v237-curtain-in {
                0%,100% {opacity:0;}
                42% {opacity:.50;}
            }
            @keyframes xd-zz-v237-curtain-out {
                0%,100% {opacity:0;}
                48% {opacity:.34;}
            }
            @media(prefers-reduced-motion:reduce) {
                .player.xd-zz-v215-masked .xd-zz-v215-veil.xd-zz-v237-entering,
                .xd-zz-v237-leavehost.player,
                .xd-zz-v237-curtain {animation:none!important;}
                .xd-zz-v237-leavehost,.xd-zz-v237-curtain {opacity:0!important;}
            }

            .player.xd-zz-v215-masked.xd-zz-v2-proto-selected,
            .xd-zz-v215-masked.player.xd-zz-v2-proto-selected {
                outline:3px solid #9be9ff!important; outline-offset:1px!important;
            }
        `;
        document.head.appendChild(style);
    };
    Z.v215SyncImagery = player => {
        if (typeof document === "undefined") return;
        if (!Z.local(player) || !Z.blind(player) || !Z.alive(player) || Z.ended) {
            Z.v215StopImagery();
            return;
        }
        if (!Z.v215ImageryActive) {
            Z.v215BeginImagery(player);
            return;
        }
        Z.v215EnsureStyle();
        Z.v283InstallDreamIntroGuard?.();
        const others = game.players.filter(p => p && p !== player);
        const current = new Set(others);
        for (const [other, record] of Z.v215Overlays) {
            if (current.has(other) && record.node === other && record.overlay?.isConnected) continue;
            try { record.node?.classList?.remove("xd-zz-v215-masked"); } catch (e) {}
            try { record.overlay?.remove(); } catch (e) {}
            try {
                if (record.originalAriaLabel === null) record.node?.removeAttribute?.("aria-label");
                else record.node?.setAttribute?.("aria-label", record.originalAriaLabel);
            } catch (e) {}
            if (record.node && "originalNoIntro" in record) {
                if (record.originalNoIntro === undefined) delete record.node._nointro;
                else record.node._nointro = record.originalNoIntro;
            }
            Z.v215Overlays.delete(other);
        }
        for (const other of others) {
            const image = Z.v215GetImagery(other);
            if (Z.v215Overlays.get(other)?.overlay?.isConnected) continue;
            if (!other?.appendChild || !other?.classList) continue;
            const originalAriaLabel = other.getAttribute?.("aria-label") ?? null;
            const veil = document.createElement("div");
            veil.className = "xd-zz-v215-veil xd-zz-v237-entering";
            veil.style.setProperty("animation-delay", Math.min(Z.v215Overlays.size * 45, 315) + "ms");
            veil.setAttribute("aria-label", "角色形象·" + image.name);
            veil.style.setProperty("--zz-ink", image.hue);
            const art = Z.v219MakeArt(veil, image);
            const glyph = document.createElement("span");
            glyph.className = "xd-zz-v215-glyph";
            glyph.textContent = image.glyph;
            const name = document.createElement("span");
            name.className = "xd-zz-v215-name";
            name.textContent = image.name;
            const edit = document.createElement("button");
            edit.type = "button";
            edit.className = "xd-zz-v216-edit";
            edit.textContent = "换";
            edit.setAttribute("aria-label", "更换角色形象");
            // “换”按钮独立拦截，不影响整张武将牌原生的点击选目标。
            for (const name of ["pointerdown", "pointerup", "mousedown", "mouseup", "touchstart", "touchend"]) {
                edit.addEventListener(name, e => { e.stopPropagation(); });
            }
            edit.addEventListener("click", e => {
                e.preventDefault();
                e.stopPropagation();
                Z.v216OpenChooser(other);
            });
            veil.append(art, glyph, name, edit);
            other.classList.add("xd-zz-v215-masked");
            other.setAttribute?.("aria-label", "角色形象·" + image.name);
            // v309：右键/长按/悬停介绍会列出真实武将、装备与判定牌；遮住期间不弹。
            const originalNoIntro = other._nointro;
            other._nointro = true;
            other.appendChild(veil);
            Z.v215Overlays.set(other, { node: other, overlay: veil, originalAriaLabel, originalNoIntro, art, glyph, name, edit });

        }
        // 死者不再留在 game.players；另外生成固定外壳，继续保留其死前最后角色形象。
        Z.v282SyncDeadDreamShells?.(player);
        Z.v216RefreshOverlayNames();
    };

    Z.refresh = () => {
        if (typeof document === "undefined") return;
        if (Z.v2proto) {
            // 正式闭眼原型始终留在玩家自己的无名杀界面；只给真实手牌切换本体原生牌背。
            document.documentElement.classList.remove("xd-zz-blind");
            document.body.classList.remove("xd-zz-blind");
            if (Z.root) {
                Z.stage.hidden = true;
                Z.modalLayer.replaceChildren();
                if (Z.root.hidePopover && Z.root.matches(":popover-open")) Z.root.hidePopover();
            }
            Z.v27SyncNativeHandMask?.(game.me);
            Z.v215SyncImagery?.(game.me);
            Z.v245SyncOtherSkillButtons?.();
            Z.v226SyncDreamReport?.();
            Z.v296SyncWuxieDialogs?.();
            Z.v241SyncDreamWallpaper?.();
            Z.v233SyncOwnButterfly?.();
            if (Z.blind(game.me)) Z.v272StartBackTracking?.();
            if ((!Z.local(game.me) || !Z.blind(game.me)) && Z.v2DestroyAll) {
                Z.v2DestroyAll("eyes-open");
            }
            return;
        }
        Z.mount();
        const blind = !Z.ended && Z.local(game.me) && Z.blind(game.me) && Z.alive(game.me);
        Z.syncSurface(blind);
        Z.v233SyncOwnButterfly?.();
        // 活跃选择保留牌/座位按钮及已选状态，窗口缩放只改变百分比布局。
        if (blind && !Z.modal && !Z.interaction) Z.drawScene();
    };

    Z.eyes = (player, count) => {
        const wasBlind = Z.blind(player);
        if (!wasBlind) {
            if (player === game.me) Z.captureLayout();
            Z.hand(player);
            Z.v301EquipOrder?.(player);
            player._xd_zz_judgeCount =
                player.getCards("j").length;
        }

        Z.state(player).closed =
            Math.max(0, Math.min(2, count));

        player.markSkill("xd_mei");
        // 只在真正开始新一段双眼闭合时重新抽签；单眼变化不提前刷新意象。
        if (Z.local(player) && !wasBlind && Z.blind(player)) Z.v215BeginImagery?.(player);
        else if (Z.local(player) && wasBlind && !Z.blind(player)) Z.v215StopImagery?.();
        Z.refresh();
        Z.v243SyncAwakeButtons?.(player);
    };

    // 自建窗口不依据合法性禁用候选。
    // 高亮仅表示玩家自己已经选择了哪个位置。
    Z.dialog = (title, build) => new Promise(resolve => {
        if (Z.modal) {
            throw new Error("庄周选择窗口重入，需检查事件时序");
        }

        Z.mount();

        const panel = document.createElement("div");
        panel.className = "zz-panel";

        const heading = document.createElement("div");
        heading.textContent = title;
        panel.appendChild(heading);

        Z.modal = panel;
        Z.modalLayer.replaceChildren(panel);
        Z.refresh();

        let done = false;

        const finish = value => {
            if (done) return;
            done = true;

            Z.modal = null;
            panel.remove();
            Z.refresh();
            resolve(value);
        };

        const row = () => {
            const element = document.createElement("div");
            element.className = "zz-row";
            panel.appendChild(element);
            return element;
        };

        const button = (parent, text, action) => {
            const element = document.createElement("button");
            element.type = "button";
            element.textContent = text;
            element.onclick = action;
            parent.appendChild(element);
            return element;
        };

        build({ panel, row, button, finish });
    });

    Z.yes = title => Z.dialog(
        title,
        ({ row, button, finish }) => {
            const controls = row();
            button(controls, "确定", () => finish(true));
            button(controls, "取消", () => finish(false));
        }
    );

    Z.choose = (title, items, labels, cancel = true) =>
        Z.dialog(title, ({ row, button, finish }) => {
            const choices = row();

            items.forEach((item, index) => {
                button(
                    choices,
                    labels[index],
                    () => finish(item)
                );
            });

            if (cancel) {
                button(row(), "取消", () => finish(null));
            }
        });

    Z.pick = (player, title, items, label, cancel = true) => {
        if (Z.local(player) && Z.blind(player) && items.length && items.every(item => Z.seats.includes(item))) {
            return Z.pickBlindTargets(title, items, cancel);
        }
        return Z.dialog(title, ({ row, button, finish }) => {
            const selected = [];
            const choices = row();

            items.forEach((item, index) => {
                const element = button(
                    choices,
                    label(item, index),
                    () => {
                        const position = selected.indexOf(item);

                        if (position < 0) selected.push(item);
                        else selected.splice(position, 1);

                        element.classList.toggle(
                            "zz-selected",
                            position < 0
                        );
                    }
                );
            });

            const controls = row();

            button(
                controls,
                "确认提交",
                () => finish(selected.slice())
            );

            if (cancel) {
                button(controls, "取消", () => finish(null));
            }
        });
    };

    Z.cardLabel = (player, card, index) =>
        Z.blind(player)
            ? "手牌 " + (index + 1)
            : get.translation(card) +
                (Z.shown(card, player) ? "［明］" : "［暗］");

    // 装备栏使用固定位置，不通过当前是否有牌来显示或隐藏按钮。
    // 此处按普通五类装备栏处理；扩展装备槽尚需适配。
    Z.blindCards = (player, position = "h") => {
        if (!/^[hej]+$/.test(position)) {
            throw new Error(
                "庄周：此特殊选牌区域尚未适配：" + position
            );
        }

        const list = [];

        if (position.includes("h")) {
            Z.hand(player).forEach((card, index) => {
                list.push({
                    card,
                    label: "手牌 " + (index + 1),
                });
            });
        }

        if (position.includes("e")) {
            for (let slot = 1; slot <= 5; slot++) {
                list.push({
                    card: player.getEquip(slot),
                    label: "装备栏 " + slot,
                });
            }
        }

        if (position.includes("j")) {
            const cards = player.getCards("j");
            const count = Math.max(
                1,
                player._xd_zz_judgeCount || 0
            );

            for (let index = 0; index < count; index++) {
                list.push({
                    card: cards[index],
                    label: "判定位置 " + (index + 1),
                });
            }
        }

        return list;
    };

    // V2.7.28: 【醒】仅在至少闭着一只眼时可以新发动。
    // 例外只允许【醒】已经真实发动、先睁眼后正在完成的*同一个*原生选牌事件；
    // 旧事件残留的 pending 不得让闭眼数为 0 的庄周再次发动【醒】。
    Z.v228PendingAwake = (player, event) => {
        const pending = player?._xd_zz_pendingAwake;
        return !!(event && pending?.request === event && !pending.cancelled &&
            event.skill === "xd_xing" && pending.frame?.mode === "awake" &&
            !pending.frame.finished && Z.allowed(player, "awake"));
    };
    Z.v228CanAwake = (player, event) =>
        Z.state(player).closed > 0 || Z.v228PendingAwake(player, event);

    Z.allowed = (player, mode) => {
        if (mode === "normal") return true;

        const skill = mode === "dream"
            ? "xd_meng"
            : "xd_xing";

        // 【梦】须至少有一只睁着的眼睛才能发动；双眼已闭时不出现【梦】按钮。
        if (mode === "dream" && Z.state(player).closed >= 2) return false;

        return player.hasSkill(skill) &&
            (
                !Z.state(player).lock ||
                Z.state(player).lock === mode
            );
    };

    // oldLock 在整次技能结算结束前一直有效。
    // 新限制与旧限制分开提交，防止解除旧锁时抹掉新锁。
    Z.begin = (player, mode) => {
        const state = Z.state(player);

        const frame = {
            player,
            mode,
            oldLock: state.lock,
            oldRevision: state.lockRevision,
            nextLock: null,
            finished: false,
        };

        if (mode === "awake") {
            Z.eyes(player, 0);
            // 【醒】点击即已消耗。原生 chooseToUse 还需要暂时保留 skill
            // 以完成选牌，但技能栏里的按钮必须从这一刻起消失。
            Z.v243GuardNativeSkillClicks?.(player);
            Z.v243SyncAwakeButtons?.(player);
        }

        player.logSkill(
            mode === "dream" ? "xd_meng" : "xd_xing"
        );

        return frame;
    };

    // v301：“下次仅能发动【梦】/【醒】”期间，庄周身上其他武将技能（含【寐】、获得的技能）一律不能发动，
    // 直到对应的【梦】/【醒】结算完成。用本体 skillBlocker 实现：不移除技能、不触发 onremove，
    // 装备技能与 charlotte 系统技能不受影响；【梦】【醒】本身仍由 Z.allowed 管。
    Z.v301LockExempt = ["xd_meng", "xd_xing", "xd_xing_empty", "xd_zhuangzhou_engine"];
    Z.v301SyncLockBlocker = player => {
        if (!player?.storage) return;
        const id = "xd_zz_lock_blocker";
        const list = player.storage.skill_blocker;
        const has = Array.isArray(list) && list.includes(id);
        if (Z.state(player).lock && !has) player.addSkillBlocker?.(id);
        else if (!Z.state(player).lock && has) player.removeSkillBlocker?.(id);
        try { _status.event?.clearStepCache?.(); } catch (e) {}
    };

    Z.finish = frame => {
        if (!frame || frame.finished) return;
        frame.finished = true;
        // 【醒】结算完毕时解除只在本次原生选牌期间启用的取消监听，
        // 避免把其它武将或其它询问的取消事件带进来。
        Z.v229DisarmCancel?.(frame);

        const player = frame.player;
        const state = Z.state(player);
        // 【醒】的先睁眼效果已发生，哪怕玩家取消 / 没有合法可用牌，本次发动也已消耗。
        // 同一 chooseToUse 对象可能在本体 UI 里复用；失败后必须连它的旧技能选择一起撤销。
        if (player._xd_zz_pendingAwake?.frame === frame) {
            const pending = player._xd_zz_pendingAwake;
            if (frame.mode === "awake" && frame.nextLock === "dream") {
                pending.cancelled = true;
                if (pending.request?.skill === "xd_xing") pending.request.skill = null;
            }
            delete player._xd_zz_pendingAwake;
        }

        if (frame.nextLock) {
            state.lock = frame.nextLock;
            state.lockRevision++;
        } else if (
            state.lockRevision === frame.oldRevision &&
            state.lock === frame.oldLock
        ) {
            state.lock = null;
            state.lockRevision++;
        }
        Z.v301SyncLockBlocker(player);

        player.markSkill("xd_mei");
        Z.refresh();
        Z.v243GuardNativeSkillClicks?.(player);
        Z.v243SyncAwakeButtons?.(player);
    };

    // V2.7.31：在同一个 chooseToUse 事件里，点【醒】后睁眼，但没有可以合法使用的牌时，
    // 玩家点“取消”会退出本次技能选牌。V2.7.28 只比对 request 身份，此时本体可能复用
    // 同一个 chooseToUse，导致 pending 仍旧为真，出现零只闭眼却能再点【醒】的假象。
    // 只在该次【醒】选牌的 checkEnd 完成以后临时接管本体取消入口，不改其它选择流程。
    Z.v230RefreshNativeChoice = player => {
        // Only after native cancel has returned: re-evaluate stale skill buttons against the
        // now-open eyes and the committed “next only 梦” lock. Does not refund chooseToUse.
        if (!Z.local(player) || typeof game.check !== "function") return;
        try {
            const active = get.event?.();
            const request = active?.name === "chooseToUse" ? active : _status.event;
            if (request?.player === player && request.name === "chooseToUse") game.check();
        } catch (e) {}
        Z.v243GuardNativeSkillClicks?.(player);
        Z.v243SyncAwakeButtons?.(player);
    };

    // 睁眼后本体仍需保留同一次 chooseToUse 的 skill 字段，才能完成选牌。
    // 但本体可能沿用之前渲染的技能按钮；不让那个旧按钮成为第二次发动入口。
    // 只检查本体技能按钮所在的小容器，不扫描或重排整张游戏桌面。
    Z.v243HiddenAwakeButtons = new Map();
    Z.v243SyncAwakeButtons = player => {
        if (!Z.local(player) || typeof document === "undefined") return;
        const hidden = Z.v243HiddenAwakeButtons;
        if (Z.state(player).closed > 0) {
            for (const [node, old] of hidden) {
                if (old.value) node.style.setProperty("display", old.value, old.priority);
                else node.style.removeProperty("display");
            }
            hidden.clear();
            return;
        }
        // 有些 UI 皮肤把技能入口移动到 control 而不是 skills*。
        const roots = [ui.skills, ui.skills2, ui.skills3, ui.control,
            document.getElementById?.("skills"),
            document.getElementById?.("skills2"),
            document.getElementById?.("skills3"),
            document.getElementById?.("control")].filter(Boolean);
        // 本体重新创建技能栏时，释放已经脱离 DOM 的旧节点，避免闭眼很久后积累引用。
        for (const node of hidden.keys()) {
            if (node.isConnected === false) hidden.delete(node);
        }
        const seen = new Set();
        for (const root of roots) {
            if (seen.has(root)) continue;
            seen.add(root);
            const nodes = [root, ...(root.children || []),
                ...(root.querySelectorAll?.(".skill,[data-skill],[data-id]") || [])];
            for (const node of nodes) {
                const id = node.link || node.dataset?.skill || node.dataset?.id ||
                    node.getAttribute?.("data-skill") || node.getAttribute?.("data-id");
                const isAwake = id === "xd_xing" || id === "xd_xing_empty" ||
                    // 少数 UI 仅在原生 skill 节点留下翻译后的技能名。
                    (node.classList?.contains("skill") && node.textContent?.trim() === "醒");
                if (!isAwake || !node.style || hidden.has(node)) continue;
                hidden.set(node, {
                    value: node.style.getPropertyValue("display"),
                    priority: node.style.getPropertyPriority("display"),
                });
                node.style.setProperty("display", "none", "important");
            }
        }
    };
    Z.v243GuardNativeSkillClicks = player => {
        if (!Z.local(player) || typeof ui.click?.skill !== "function") return;
        // 已在【醒】原生选牌中时，不能再包裹 v229 的临时监听器。
        // 否则结束时检测不到旧函数，导致取消/技能事件残留。
        const pending = player._xd_zz_pendingAwake;
        if (pending?.frame?._xd_zz_skillGuard?.wrapped === ui.click.skill) return;
        if (ui.click.skill._xd_zz_v243AwakeGuard) return;
        const original = ui.click.skill;
        const wrapped = function (...args) {
            const id = typeof args[0] === "string" ? args[0] :
                (this?.link || this?.dataset?.skill || this?.dataset?.id ||
                    args[0]?.currentTarget?.link || args[0]?.currentTarget?.dataset?.skill);
            if (Z.local(player) && Z.state(player).closed === 0 &&
                (id === "xd_xing" || id === "xd_xing_empty" ||
                    (this?.classList?.contains("skill") && this.textContent?.trim() === "醒"))) {
                return; // 即使本体留着旧按钮，也绝不再次提交已消耗的【醒】。
            }
            return original.apply(this, args);
        };
        wrapped._xd_zz_v243AwakeGuard = true;
        ui.click.skill = wrapped;
    };
    // 保守方案：不伪造或冻结已经失去的原生技能（那需要重写原生技能发动器）。
    // 仅在本地庄周双闭眼期间隐藏其它原生主动技能按钮，保留【梦】【醒】。
    // 只检查原生技能小容器及其新建子节点，不扫描整桌或加入逐帧任务。
    Z.v245MaskedOtherSkillButtons = new Map();
    Z.v245OtherSkillObserver = null;
    Z.v245ObservedSkillRoots = [];
    Z.v245RestoreOtherSkillButtons = () => {
        Z.v245OtherSkillObserver?.disconnect?.();
        Z.v245OtherSkillObserver = null;
        Z.v245ObservedSkillRoots = [];
        for (const [node, old] of Z.v245MaskedOtherSkillButtons) {
            try {
                if (old.visibility) node.style.setProperty("visibility", old.visibility, old.visibilityPriority);
                else node.style.removeProperty("visibility");
                if (old.pointerEvents) node.style.setProperty("pointer-events", old.pointerEvents, old.pointerPriority);
                else node.style.removeProperty("pointer-events");
                if (old.ariaHidden === null) node.removeAttribute?.("aria-hidden");
                else node.setAttribute?.("aria-hidden", old.ariaHidden);
            } catch (e) {}
        }
        Z.v245MaskedOtherSkillButtons.clear();
    };
    Z.v245SyncOtherSkillButtons = () => {
        const player = game.me;
        if (typeof document === "undefined" || !player || !Z.local(player) ||
            !Z.blind(player) || Z.ended) {
            if (Z.v245MaskedOtherSkillButtons.size || Z.v245OtherSkillObserver)
                Z.v245RestoreOtherSkillButtons();
            return;
        }
        const roots = [...new Set([
            ui.skills, ui.skills2, ui.skills3,
            document.getElementById?.("skills"),
            document.getElementById?.("skills2"),
            document.getElementById?.("skills3"),
            // 部分界面皮肤把技能按钮搬到 control 中；仅选择有技能身份的节点。
            ui.control, document.getElementById?.("control"),
        ].filter(Boolean))];
        const keep = node => {
            const id = node?.link || node?.dataset?.skill || node?.getAttribute?.("data-skill");
            const label = node?.textContent?.trim();
            return id === "xd_meng" || id === "xd_xing" || id === "xd_xing_empty" ||
                (node?.classList?.contains("skill") && (label === "梦" || label === "醒"));
        };
        const nodes = new Set();
        for (const root of roots) {
            // 仅含技能语义的节点，绝不隐藏确认/取消、结束出牌等原生游戏控制。
            if (root.classList?.contains("skill") || root.dataset?.skill) nodes.add(root);
            for (const child of root.querySelectorAll?.(".skill,[data-skill]") || []) nodes.add(child);
            // 本体的 skills 容器直接以 .link 表示技能时也识别它。
            if (root === ui.skills || root === ui.skills2 || root === ui.skills3) {
                for (const child of root.children || []) if (typeof child.link === "string") nodes.add(child);
            }
        }
        for (const node of nodes) {
            if (!node?.style || !node.isConnected) continue;
            if (keep(node)) {
                const old = Z.v245MaskedOtherSkillButtons.get(node);
                if (old) {
                    if (old.visibility) node.style.setProperty("visibility", old.visibility, old.visibilityPriority);
                    else node.style.removeProperty("visibility");
                    if (old.pointerEvents) node.style.setProperty("pointer-events", old.pointerEvents, old.pointerPriority);
                    else node.style.removeProperty("pointer-events");
                    if (old.ariaHidden === null) node.removeAttribute?.("aria-hidden");
                    else node.setAttribute?.("aria-hidden", old.ariaHidden);
                    Z.v245MaskedOtherSkillButtons.delete(node);
                }
                continue;
            }
            if (!Z.v245MaskedOtherSkillButtons.has(node)) {
                Z.v245MaskedOtherSkillButtons.set(node, {
                    visibility: node.style.getPropertyValue("visibility"),
                    visibilityPriority: node.style.getPropertyPriority("visibility"),
                    pointerEvents: node.style.getPropertyValue("pointer-events"),
                    pointerPriority: node.style.getPropertyPriority("pointer-events"),
                    ariaHidden: node.getAttribute?.("aria-hidden") ?? null,
                });
            }
            if (node.style.getPropertyValue("visibility") !== "hidden")
                node.style.setProperty("visibility", "hidden", "important");
            if (node.style.getPropertyValue("pointer-events") !== "none")
                node.style.setProperty("pointer-events", "none", "important");
            node.setAttribute?.("aria-hidden", "true");
        }
        for (const node of Z.v245MaskedOtherSkillButtons.keys())
            if (node.isConnected === false) Z.v245MaskedOtherSkillButtons.delete(node);
        // 不监控 ui.control（原生出牌过程经常修改它），避免把技能遮蔽变成逐牌重活。
        // 只监听技能小容器的直接子节点增删；checkEnd 负责其它原生重绘时序。
        const observed = roots.filter(root => root !== ui.control &&
            root !== document.getElementById?.("control"));
        if (typeof MutationObserver === "function" &&
            (observed.length !== Z.v245ObservedSkillRoots.length ||
            observed.some((root, i) => root !== Z.v245ObservedSkillRoots[i]))) {
            Z.v245OtherSkillObserver?.disconnect?.();
            const observer = new MutationObserver(() => Z.v245SyncOtherSkillButtons());
            for (const root of observed) observer.observe(root, { childList: true });
            Z.v245OtherSkillObserver = observer;
            Z.v245ObservedSkillRoots = observed;
        }
    };

    Z.v229DisarmCancel = frame => {
        const guard = frame?._xd_zz_cancelGuard;
        if (guard) {
            if (guard.click.cancel === guard.wrapped) guard.click.cancel = guard.original;
            delete frame._xd_zz_cancelGuard;
        }
        const skillGuard = frame?._xd_zz_skillGuard;
        if (skillGuard) {
            if (skillGuard.click.skill === skillGuard.wrapped) skillGuard.click.skill = skillGuard.original;
            delete frame._xd_zz_skillGuard;
        }
        const cardGuard = frame?._xd_zz_cardGuard;
        if (cardGuard) {
            if (cardGuard.replace.card === cardGuard.wrapped) {
                if (cardGuard.original === undefined) delete cardGuard.replace.card;
                else cardGuard.replace.card = cardGuard.original;
            }
            delete frame._xd_zz_cardGuard;
        }
    };
    Z.v229ArmCancel = (player, pending) => {
        const click = ui.click;
        if (!pending || pending.cancelled || pending.frame?.finished || typeof click?.cancel !== "function") return;
        if (pending.frame._xd_zz_cancelGuard?.wrapped === click.cancel) return;
        // 上一次封装若被本体重设，这里沿用最新的原生 cancel，不叠加旧封装。
        const original = click.cancel;
        const wrapped = function (...args) {
            // 只有已经先睁眼、尚未成功进入 onuse 的这次【醒】，取消才应执行“否则”。
            // 在真正调用本体 cancel 前取消 pending 资格：若本体同步刷新技能栏，就不会再次显示【醒】。
            const active = player._xd_zz_pendingAwake === pending &&
                !pending.cancelled && !pending.frame.finished &&
                Z.state(player).closed === 0; // native may already have cleared request.skill before cancel hook
            if (!active) return original.apply(this, args);
            // 牌一经选择即承诺使用，不允许玩家通过手动点原生“取消”撤回。
            // 本体在成功提交时可能内部调用 cancel() 清理 UI；不拦截这种无点击事件的内部调用。
            if (pending.frame.material && args[0]?.type === "click") return;
            pending.cancelled = true;
            if (click.cancel === wrapped) click.cancel = original;
            try {
                return original.apply(this, args);
            } finally {
                if (!pending.frame.finished) {
                    Z.fail(pending.frame);
                    Z.finish(pending.frame);
                }
                Z.v230RefreshNativeChoice(player);
            }
        };
        click.cancel = wrapped;
        pending.frame._xd_zz_cancelGuard = { click, original, wrapped };
        // 睁眼后的本次 chooseToUse 可继续选牌，但不允许再次点击残留的【醒】入口。
        if (!pending.frame._xd_zz_skillGuard && typeof click.skill === "function") {
            const oldSkill = click.skill;
            const skillGuard = function (...args) {
                const chosen = typeof args[0] === "string" ? args[0] :
                    (this?.link || this?.dataset?.skill);
                if ((chosen === "xd_xing" || chosen === "xd_xing_empty") &&
                    player._xd_zz_pendingAwake === pending && !pending.frame.finished &&
                    Z.state(player).closed === 0) return;
                return oldSkill.apply(this, args);
            };
            click.skill = skillGuard;
            pending.frame._xd_zz_skillGuard = { click, original: oldSkill, wrapped: skillGuard };
        }
    };
    Z.v229AwakeSelectionReady = event => {
        if (Z.v294NativeValidation?.event === event) return;
        const player = event?.player;
        if (player !== game.me || !Z.local(player)) return;
        const pending = player._xd_zz_pendingAwake;
        if (pending?.request === event && !pending.cancelled &&
            event.skill === "xd_xing" && !pending.frame?.finished && Z.state(player).closed === 0) {
            Z.v229ArmCancel(player, pending);
        }
    };

    // 【醒】已睁眼后，先用本体的真实合法性判断暗置牌，不能仅凭“手里有暗牌”
    // 就让一个已经耗尽出杀次数的【杀】留在选牌界面里。
    Z.v242HasUsableAwakeCard = event => {
        const player = event?.player;
        if (!player) return false;
        return player.getCards("h").some(card => {
            if (Z.shown(card, player)) return false;
            try {
                if (!Z.withSelection({ cards: [], targets: [] }, () =>
                    !event.filterCard || event.filterCard(card, player, event))) return false;
                return Z.withSelection({ cards: [card], targets: [] }, () => {
                    const candidate = get.card?.() || card;
                    return (!lib.filter.cardUsable || lib.filter.cardUsable(candidate, player, event)) &&
                        (!lib.filter.cardEnabled || lib.filter.cardEnabled(candidate, player, event));
                });
            } catch (e) {
                // 本体遇到特殊动态技能的合法性尚不可判定时，不擅自触发“否则”。
                return true;
            }
        });
    };

    // 选中第一张合法暗牌后即锁定本次选择；真正的原生明置事件仍在
    // useCardBefore 中发生（避免在 chooseToUse 的 game.check 内插入异步事件）。
    Z.v242LockAwakeMaterial = (pending, material) => {
        const frame = pending.frame;
        if (frame.material || frame.finished) return;
        frame.material = material;
        const event = pending.request;
        event.custom ||= {};
        event.custom.replace ||= {};
        const replace = event.custom.replace;
        const original = replace.card;
        const wrapped = function () {
            // 不允许换牌或取消已选中的牌；选择目标与必要的“确定”仍由本体处理。
            if (pending.frame.material && !pending.frame.finished) return;
            if (typeof original === "function") return original.apply(this, arguments);
        };
        replace.card = wrapped;
        frame._xd_zz_cardGuard = { replace, original, wrapped };
    };

    Z.v242AwakeAfterCheck = event => {
        if (Z.v294NativeValidation?.event === event) return;
        if (event?.name !== "chooseToUse" || event.skill !== "xd_xing") return;
        const player = event.player;
        const pending = player?._xd_zz_pendingAwake;
        if (!pending || pending.request !== event || pending.cancelled ||
            pending.frame.finished || Z.state(player).closed !== 0 || !Z.local(player)) return;

        // 原生选牌被确认的那一刻锁定材料，不允许点击其他牌纠正。
        if (!pending.frame.material) {
            const chosen = ui.selected?.cards?.[0];
            if (chosen && player.getCards("h").includes(chosen) && !Z.shown(chosen, player)) {
                Z.v242LockAwakeMaterial(pending, chosen);
            }
        }

        if (!pending.frame.material) {
            // 优先相信原生 game.check 已显示的可选状态；只在确实无候选时自动“否则”。
            if (player.getCards("h").some(card => !Z.shown(card, player) &&
                card.classList?.contains("selectable"))) return;
            if (pending._xd_zz_noLegalQueued || Z.v242HasUsableAwakeCard(event)) return;
            pending._xd_zz_noLegalQueued = true;
            // 不在 game.check 的调用栈内取消选牌，以免与本体同步刷新技能栏冲突。
            Promise.resolve().then(() => {
                if (player._xd_zz_pendingAwake !== pending || pending.frame.finished ||
                    pending.frame.material || get.event?.() !== event) return;
                Z.fail(pending.frame);
                Z.finish(pending.frame);
                // 【醒】不能替代本体正在询问的正常出牌；释放这次技能子选择。
                if (typeof ui.click.cancel === "function") ui.click.cancel();
                if (typeof event.goto === "function") event.goto(0);
                Z.v230RefreshNativeChoice(player);
            });
            return;
        }

        // 普通固定目标数的牌沿用原生“选完即出”；变动目标数的牌（铁索、
        // 方天画戟加目标等）必须由玩家自己按确定。不猜测额外指定目标的上限。
        if (pending._xd_zz_autoOkQueued || get.name(pending.frame.material, player) === "tiesuo") return;
        let range;
        try { range = Z.v2GetRange(event.selectTarget); } catch (e) { return; }
        if (!range || range[0] !== range[1] || range[0] < 0 ||
            ui.selected.cards?.[0] !== pending.frame.material ||
            ui.selected.targets?.length !== range[0] ||
            (event.filterOk && !event.filterOk())) return;
        pending._xd_zz_autoOkQueued = true;
        Promise.resolve().then(() => {
            pending._xd_zz_autoOkQueued = false;
            if (player._xd_zz_pendingAwake !== pending || pending.frame.finished ||
                get.event?.() !== event || event.skill !== "xd_xing" ||
                ui.selected.cards?.[0] !== pending.frame.material ||
                ui.selected.targets?.length !== range[0] ||
                (event.filterOk && !event.filterOk())) return;
            ui.click.ok();
        });
    };

    Z.fail = frame => {
        if (!frame || frame.finished) return;
        const nextLock = frame.mode === "dream" ? "awake" : "dream";
        frame.nextLock = nextLock;
        // 技能原文的“否则”落实为下次发动限制。战报只展示实际限制，
        // 同一次发动即使经多个事件检查也只记录一次。
        if (!frame._xd_zz_lockLogged) {
            frame._xd_zz_lockLogged = true;
            game.log(frame.player, "下次仅能发动【" +
                (nextLock === "dream" ? "梦" : "醒") + "】");
        }
    };

    Z.expel = async (player, reason) => {
        if (!Z.alive(player)) return;
        // 测试模式统一拦住违规退场，包含火攻和延后发现的错误牌。
        if (Z.v274SafeTestMode) {
            Z.v2Notice("TEST INVALID（仅提示，不判负）：" + reason);
            return;
        }

        game.log(
            player,
            "因庄周规则违规退场：",
            reason
        );

        // 当前采用本体死亡流程；死亡联动由游戏模式继续处理。
        const event = player.die();
        event._xd_zz_violation = true;
        await event;

        Z.refresh();
        Z.v243SyncAwakeButtons?.(player);
    };

    Z.recast = async token => {
        const player = token.player;
        const frame = token.frame;
        if (!frame || !Z.alive(player)) return;

        // 【梦】强制重铸同花色明置牌；【醒】强制重铸同花色暗置牌。
        // 必须在本次使用的牌效与所有插入后续事件结算结束后，按最新手牌状态取快照。
        const shown = frame.mode === "dream";
        const matching = player.getCards("h").filter(card =>
            Z.shown(card, player) === shown &&
            get.suit(card, player) === token.fact.suit
        );
        if (!matching.length) {
            Z.useTrace(token, "没有同花色的" + (shown ? "明置" : "暗置") + "手牌可重铸");
            Z.fail(frame);
            // 【梦】即使没有牌可重铸，仍闭上双眼；“否则”只带来下次仅能发动【醒】的限制。
            if (frame.mode === "dream" && Z.alive(player)) Z.eyes(player, 2);
            return;
        }

        if (frame.mode === "awake") {
            // 【醒】同时重铸所有符合条件的同花色暗置牌（一次原生重铸事件），不能重铸的牌留在原处；
            // 至少真正重铸一张才算完成。不能仅凭调用了 recast 就算成功，部分技能会令重铸事件失效。
            const eligible = matching.filter(card => {
                if (typeof player.canRecast === "function" && !player.canRecast(card)) return false;
                // 例如【黠慧】的黑牌不能弃置；在进入原生重铸前过滤，避免整批中断。
                if (lib.filter.cardDiscardable && !lib.filter.cardDiscardable(card, player, "recast")) return false;
                return true;
            });
            let succeeded = 0;
            if (eligible.length) {
                try {
                    await player.recast(eligible);
                } catch (error) {
                    Z.useTrace(token, "整批重铸未完成");
                    try { console.warn("[庄周·醒] 重铸失败", error); } catch (e) {}
                }
                // 只有实体材料真实离开手牌，才视作这张牌的重铸已经完成。
                const hand = player.getCards("h");
                succeeded = eligible.filter(card => !hand.includes(card)).length;
            }
            Z.useTrace(token, "【醒】真实成功重铸" + succeeded + "/" + matching.length + "张");
            if (!Z.alive(player)) return;
            if (!succeeded) Z.fail(frame);
            return;
        }

        // 【梦】仍沿用实测成功的整批原生重铸逻辑，不顺手修改。
        Z.useTrace(token, "自动重铸全部" + matching.length + "张同花色明置手牌");
        await player.recast(matching);
        Z.useTrace(token, "原生recast调用已返回");

        if (!Z.alive(player)) return;
        if (frame.mode === "dream") {
            // 重铸后闭上双眼（重铸失牌仍可能先插入【寐】）。已双闭眼时保持不变，不触发“否则”。
            if (Z.state(player).closed !== 2) Z.eyes(player, 2);
        }
    };

    Z.makeToken = (player, mode, material, frame) => {
        const fact = Z.fact(material, player);
        const printedType = get.type({ name: fact.name }, null, false);
        const token = {
            id: ++Z.serial, player, mode, material, frame, fact,
            // 装备与延时锦囊必须保留实体材料，才能在“先翻面 → 离开手牌 → 进入装备/判定区”的真实结算链中移动区域。
            zoneTransfer: printedType === "equip" || printedType === "delay",
            flipped: false, used: false, finished: false,
        };
        Z.tokens.set(token.id, token);
        return token;
    };

    Z.makeCard = token => {
        // 基本牌/普通锦囊按技能定义保留实体手牌；装备/延时锦囊必须携带实体材料完成区域转移。
        const materials = token.zoneTransfer ? [token.material] : [];
        const card = new lib.element.VCard(token.material, materials, undefined, undefined, token.player);
        Object.assign(card, token.fact);
        card.storage.xd_zhuangzhou_token = token.id;
        return card;
    };

    Z.tokenOf = event => Z.tokens.get(event.card?.storage?.xd_zhuangzhou_token);

    // V2.7.12 调试回归：只记录【梦】【醒】的实际用牌事件，不碰其它武将。
    // 后续如果效果仍未结算，游戏日志足以分辨中断发生在 onuse、useCardBefore 或 useCard1 之前。
    Z.useTrace = (token, stage) => {
        if (!token) return;
        token.trace ||= [];
        token.trace.push(stage);
        try { console.log("[庄周V2.7.12 用牌链]", token.id, token.mode, stage); } catch (e) {}
        if (Z.v274SafeTestMode && Z.local(token.player)) {
            try { game.log("【庄周2.7.12】", token.mode === "dream" ? "梦" : "醒", stage); } catch (e) {}
        }
    };

    Z.complete = async token => {
        if (!token || token.finished) return;
        token.finished = true;
        try {
            if (token.used) await Z.recast(token);
        } finally {
            if (token.used) {
                Z.finish(token.frame);
            } else if (token.frame?.mode === "awake" && !token.frame.finished) {
                // 【醒】已经先睁眼；若真正的 useCard 在进入 useCard1 前被取消，后半句未完成，应走“否则”。
                Z.fail(token.frame);
                Z.finish(token.frame);
            }
            Z.tokens.delete(token.id);
            Z.refresh();
        }
    };

    // v1.11.5.2 的 insertAfter 在 useCardAfter 及其子事件完成后运行。
    // 同时覆盖直接使用与无懈 nouse → 外层 useResult 两条入口。
    Z.afterUse = async function (event) {
        const z = lib.xd_utils.zhuangzhou;
        // 其他技能也可能向 useCard.after 追加效果；先让它们完成，再取重铸快照。
        if (event.useEvent.after.length) {
            event.useEvent.insertAfter(z.afterUse, {
                player: event.player, token: event.token, useEvent: event.useEvent, forceDie: true,
            });
            return;
        }
        z.useTrace(event.token, "牌的使用事件已结束，开始处理后续重铸");
        await z.complete(event.token);
    };
    const originalUseCard = PP.useCard;
    PP.useCard = function (...args) {
        const next = originalUseCard.apply(this, args);
        const token = Z.tokenOf(next);
        if (token) {
            // 只记录这次【梦】【醒】首次生成的原生用牌事件；供重复进入时诊断。
            token.firstUseEvent ||= next;
            Z.useTrace(token, "useCard事件已创建");
            next.insertAfter(Z.afterUse, { player: this, token, useEvent: next, forceDie: true });
        }
        return next;
    };

    Z.range = value => {
        if (typeof value === "function") {
            value = value();
        }

        if (value == null) return [1, 1];

        return typeof value === "number"
            ? [value, value]
            : value;
    };

    Z.countOK = (items, specification) => {
        const range = Z.range(specification);

        return range[0] >= 0 &&
            items.length >= range[0] &&
            (
                range[1] < 0 ||
                items.length <= range[1]
            );
    };

    Z.test = (filter, ...args) => {
        if (!filter) return true;

        if (typeof filter === "function") {
            return !!filter(...args);
        }

        if (typeof filter !== "object") {
            throw new Error("庄周遇到未知选择过滤器");
        }

        const card = args[0];

        return Object.entries(filter).every(
            ([key, expected]) => {
                const actual =
                    typeof get[key] === "function"
                        ? get[key](card)
                        : card[key];

                return Array.isArray(expected)
                    ? expected.includes(actual)
                    : actual === expected;
            }
        );
    };

    Z.withSelection = (value, callback) => {
        const old = {};

        for (const key of Object.keys(value)) {
            old[key] = ui.selected[key];
            ui.selected[key] = value[key];
        }

        try {
            return callback();
        } finally {
            Object.assign(ui.selected, old);
        }
    };

    // 普通盲选的牌面错误，必须等证据公开。
    // 重铸选错不走这里，按已确认规则直接退场。
    Z.defer = (player, cards, reason) => {
        if (cards.length) {
            Z.pending.push({
                player,
                cards: cards.slice(),
                reason,
            });
        }
    };

    Z.checkEvidence = async (cards, discardOnly) => {
        const publicCards = cards.filter(card =>
            !discardOnly ||
            card.parentNode === ui.discardPile
        );

        for (const record of Z.pending.slice()) {
            if (
                record.cards.some(card =>
                    publicCards.includes(card)
                )
            ) {
                Z.pending.splice(
                    Z.pending.indexOf(record),
                    1
                );

                await Z.expel(record.player, record.reason);
            }
        }
    };

    Z.targetSpec = (request, card, player) => {
        const value = request.selectTarget ?? lib.filter.selectTarget;
        return Z.range(typeof value === "function" ? value(card, player) : value);
    };

    Z.cardOK = (request, player, material) => {
        if (!material || !player.getCards("h").includes(material)) return false;
        if (!Z.test(request.filterCard, material, player, request)) return false;
        if (request.name === "chooseToRespond") {
            return lib.filter.cardRespondable(material, player, request);
        }
        // 请求 filterCard 保留“闪”等 forceEnable 语义，不再额外按出牌阶段 enable 判死。
        return lib.filter.cardUsable(material, player, request);
    };

    Z.validate = (request, player, material, targets) => {
        if (!Z.cardOK(request, player, material)) return false;
        if (request.name === "chooseToRespond") return targets.length === 0;
        const card = Z.fact(material, player);
        const info = get.info(card);
        if (!info) return false;
        const filter = request.filterTarget || lib.filter.filterTarget;
        const range = Z.targetSpec(request, card, player);
        if (request.type === "dying" && request.dying) {
            if (!lib.filter.cardSavable(material, player, request.dying)) return false;
            if (targets.length && (targets.length !== 1 || targets[0] !== request.dying)) return false;
            targets.splice(0, targets.length, request.dying);
        } else if (range[1] === -1) {
            // 自己/全体目标由牌规则指定，提交时不要求逐个点选；不允许借此输入额外目标。
            const all = game.players.filter(target => Z.withSelection(
                { cards: [material], targets: [] },
                () => Z.test(filter, card, player, target)
            ));
            if (targets.length && (targets.length !== all.length || targets.some(t => !all.includes(t)))) return false;
            targets.splice(0, targets.length, ...all);
        } else if (!Z.countOK(targets, range)) return false;
        if (new Set(targets).size !== targets.length) return false;
        const prefix = [];
        for (const target of targets) {
            if (!Z.alive(target) || !Z.withSelection(
                { cards: [material], targets: prefix },
                () => Z.test(filter, card, player, target)
            )) return false;
            prefix.push(target);
        }
        return Z.withSelection({ cards: [material], targets }, () =>
            (!request.filterOk || request.filterOk()) &&
            (!info.multicheck || info.multicheck(card, player))
        );
    };

    // V2.7.6：作者补充澄清【醒】有两个互斥入口。
    // 仍有暗置手牌时：先睁眼，再必须选 1 张暗置牌明置并使用；不能空选跳过。
    // 已无任何暗置手牌时：仍可直接发动【醒】，不要求材料，也不经过“确定”按钮；睁眼后因后续无法完成而走“否则”。
    Z.hasAwakeMaterial = player =>
        player.getCards("h").some(card => !Z.shown(card, player));

    // 牌与目标在同一窗口中提交；提交之前均可修改，双眼闭合时不按牌面筛选或提示。
    Z.chooseAction = (request, mode, committed) => {
        const player = request.player;
        const blind = Z.blind(player);
        const respond = request.name === "chooseToRespond";
        const hand = Z.hand(player);
        const choices = blind || mode === "normal" ? hand :
            hand.filter(card => Z.shown(card, player) === (mode === "dream"));
        Z.rememberSeats();
        return Z.dialog(respond ? "选择打出的手牌" : "选择手牌与目标", ({ row, button, finish }) => {
            let material = null;
            const targets = [];
            const cardsRow = row(), cardButtons = [];
            choices.forEach(card => {
                const element = button(cardsRow, Z.cardLabel(player, card, hand.indexOf(card)), () => {
                    material = card;
                    cardButtons.forEach(item => item.classList.remove("zz-selected"));
                    element.classList.add("zz-selected");
                });
                cardButtons.push(element);
            });
            if (!respond) {
                row().textContent = "无需指定目标或目标由牌规则自动确定时，可不选座位。";
                const targetRow = row();
                Z.seats.forEach((target, index) => {
                    const element = button(targetRow,
                        "座位 " + (index + 1) + (blind ? "" : "：" + get.translation(target)), () => {
                            const i = targets.indexOf(target);
                            if (i < 0) targets.push(target); else targets.splice(i, 1);
                            element.classList.toggle("zz-selected", i < 0);
                        });
                });
            }
            const controls = row();
            button(controls, "确认提交", () => {
                if (material) finish({ material, targets: targets.slice(), blind });
            });
            if (!committed) button(controls, "取消", () => finish(null));
        });
    };

    // 可见时的普通操作交回原生询问，保留装备技能、虚拟牌和原询问的回调。
    // 传递原参数和 .set 参数，不复制事件队列/Promise 内部状态。
    Z.nativeRequest = async request => {
        const next = Z.raw[request.name].apply(request.player, request._args || []);
        for (const [key, value] of request._set || []) next.set(key, value);
        for (const key of [
            "type", "filterCard", "filterTarget", "selectCard", "selectTarget", "filterOk",
            "position", "forced", "prompt", "prompt2", "nouse", "chooseonly", "dying",
            "addCount", "oncard", "onresult", "respondTo", "source", "animate", "noOrdering",
            "logSkill", "ai1", "ai2", "toUse", "shanRequired", "id", "id2", "info_map",
        ]) if (request[key] !== undefined) next[key] = request[key];
        // 某些本体次数判断只看 getParent() 是否 phaseUse；跳过这层选择方式窗口。
        const getParent = next.getParent;
        next.getParent = function (level, ...args) {
            if (level === undefined || level === 1) return request.getParent();
            return getParent.call(this, level, ...args);
        };
        await next;
        request.result = next.result;
        request._result = next._result;
        return !!next.result?.bool;
    };

    // 目录只取本局牌堆的公开构成，不读取手牌，不按次数/距离/目标合法性筛选。
    Z.declarationMenu = category => {
        const names = Array.from(new Set(lib.inpile || [])).filter(name => lib.card[name]);
        const type = name => get.type({ name }, null, false);
        const subtype = name => get.subtype({ name });
        const named = list => list.map(name => ({ key: name, name, label: get.translation(name) }));
        if (category === "basic") return named(["sha", "tao", "jiu"].filter(name => lib.card[name]));
        if (category === "trick") return named(names.filter(name => name !== "wuxie" &&
            (type(name) === "trick" || ["lebu", "bingliang", "shandian"].includes(name))));
        if (category === "equip") return [
            { key: "weapon", label: "武器", branch: "weapon" },
            { key: "armor", label: "防具", branch: "armor" },
            { key: "horse_plus", label: "+1马", subtype: "equip3" },
            { key: "horse_minus", label: "-1马", subtype: "equip4" },
            { key: "treasure", label: "宝物", branch: "treasure" },
        ];
        const equipType = { weapon: "equip1", armor: "equip2", treasure: "equip5" }[category];
        return equipType ? named(names.filter(name => type(name) === "equip" && subtype(name) === equipType)) : [];
    };
    Z.matchesDeclaration = (declaration, material, player) => {
        if (!declaration) return false;
        if (declaration.subtype) return get.type(material, null, false) === "equip" && get.subtype(material) === declaration.subtype;
        return declaration.name === get.name(material, player);
    };
    Z.responsePrompt = request => {
        const respond = request.name === "chooseToRespond";
        if (request.type === "respondShan") return "请使用闪响应";
        if (request.type === "wuxie") return "是否使用无懈可击？";
        if (request.type === "dying") return request.dying === request.player ? "是否使用桃或酒自救？" : "是否使用桃救援？";
        // 只提取询问中的动作与牌名，原 prompt 的其他角色/区域等信息不带进梦境。
        const text = typeof request.prompt === "string" ? request.prompt.replace(/<[^>]*>/g, "") : "";
        const match = text.match(/(?:使用|打出)[^。；？\n]{0,16}?(无懈可击|杀|闪|桃|酒)/);
        if (match) return "请" + (respond ? "打出" : "使用") + match[1] + "响应";
        // 决斗、南蛮、万箭是公开的出牌事件；只读取这一层要求，不读取对方新状态。
        const parent = request.getParent?.();
        const name = parent?.card?.name || parent?.name;
        if (respond && ["juedou", "nanman"].includes(name)) return "请打出杀响应";
        if (respond && name === "wanjian") return "请打出闪响应";
        return respond ? "请按当前要求打出手牌" : "请按当前要求使用手牌";
    };
    Z.sceneButton = (parent, label, action, className = "") => {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = label;
        button.className = className;
        button.onclick = action;
        parent.appendChild(button);
        return button;
    };
    Z.chooseBlindAction = request => new Promise(resolve => {
        if (Z.modal || Z.interaction) throw new Error("庄周选择窗口重入");
        Z.mount();
        Z.drawScene();
        Z.interaction = { request };
        Z.syncSurface(true);
        const player = request.player;
        const respond = request.name === "chooseToRespond";
        const free = !respond && request.type === "phase";
        let material = null, declaration = null, mode = "normal", menu = null;
        const targets = [];
        const actions = document.createElement("div");
        actions.className = "zz-actions";
        const prompt = document.createElement("div");
        prompt.className = "zz-prompt";
        prompt.textContent = free ? "先选一张手牌，再说说它是什么。" : Z.responsePrompt(request);
        const summary = document.createElement("div");
        summary.className = "zz-summary";
        const controls = document.createElement("div");
        controls.className = "zz-controls";
        actions.append(prompt, summary, controls);
        Z.stage.appendChild(actions);
        let done = false;
        const finish = value => {
            if (done) return;
            done = true;
            Z.interaction = null;
            Z.refresh();
            resolve(value);
        };
        Z.interaction.cancel = () => finish(null);
        const update = () => {
            const index = material ? Z.hand(player).indexOf(material) + 1 : 0;
            summary.textContent = (index ? "手牌 " + index : "尚未选牌") +
                (free ? " · " + (declaration?.label || "尚未声明") : "") +
                (mode === "dream" ? " · 梦" : "") +
                (targets.length ? " · 目标：" + targets.map(t => Z.seats.indexOf(t) + 1).join("、") : "");
            // 禁用确认只依赖用户尚未完成的输入，不依据任何隐藏合法性。
            confirm.disabled = !material || (free && !declaration);
            if (dream) dream.classList.toggle("zz-selected", mode === "dream");
            declare.disabled = !material;
        };
        const openMenu = category => {
            menu?.remove();
            menu = document.createElement("div");
            menu.className = "zz-menu";
            const heading = document.createElement("div");
            heading.className = "zz-menu-title";
            heading.textContent = category ? ({ basic: "基本牌", trick: "锦囊牌", equip: "装备牌", weapon: "武器", armor: "防具", treasure: "宝物" }[category]) : "你觉得这张牌是什么类别？";
            const list = document.createElement("div");
            list.className = "zz-menu-list";
            menu.append(heading, list);
            const entries = category ? Z.declarationMenu(category) : [
                { label: "基本牌", branch: "basic" }, { label: "锦囊牌", branch: "trick" }, { label: "装备牌", branch: "equip" },
            ];
            entries.forEach(entry => Z.sceneButton(list, entry.label, () => {
                if (entry.branch) openMenu(entry.branch);
                else { declaration = entry; menu.remove(); menu = null; update(); }
            }));
            const nav = document.createElement("div");
            nav.className = "zz-row";
            if (category) Z.sceneButton(nav, "返回上一级", () => openMenu(["weapon", "armor", "treasure"].includes(category) ? "equip" : null), "zz-quiet");
            Z.sceneButton(nav, "收起", () => { menu.remove(); menu = null; }, "zz-quiet");
            menu.appendChild(nav);
            Z.stage.appendChild(menu);
        };
        Z.handButtons.forEach((button, card) => {
            button.onclick = () => {
                material = card;
                // 换牌需要重新声明，避免把上张牌的选择误提交。
                declaration = null;
                Z.handButtons.forEach((element, current) => element.classList.toggle("zz-selected", current === card));
                update();
                if (free) openMenu(null);
            };
        });
        Z.seatButtons.forEach((button, target) => {
            button.onclick = () => {
                if (respond) return;
                const index = targets.indexOf(target);
                if (index < 0) targets.push(target); else targets.splice(index, 1);
                button.classList.toggle("zz-selected", index < 0);
                update();
            };
        });
        const declare = Z.sceneButton(controls, "重新声明", () => openMenu(null));
        declare.hidden = !free;
        const dream = !respond && Z.allowed(player, "dream") ?
            Z.sceneButton(controls, "梦", () => { mode = mode === "dream" ? "normal" : "dream"; update(); }) : null;
        if (!respond && Z.allowed(player, "awake") && Z.state(player).closed > 0) {
            Z.sceneButton(controls, "醒 · 睁眼", () => finish({ awake: true }));
        }
        const confirm = Z.sceneButton(controls, "确定", () => {
            if (material && (!free || declaration)) finish({ material, declaration, targets: targets.slice(), mode, blind: true, free });
        }, "zz-primary");
        Z.sceneButton(controls, "取消选择", () => {
            material = null; declaration = null; mode = "normal"; targets.length = 0;
            menu?.remove(); menu = null;
            Z.handButtons.forEach(button => button.classList.remove("zz-selected"));
            Z.seatButtons.forEach(button => button.classList.remove("zz-selected"));
            update();
        }, "zz-quiet");
        Z.sceneButton(controls, free ? "结束出牌" : "不响应", () => finish(null), "zz-quiet");
        update();
    });
    Z.blindRequest = async request => {
        request.result = { bool: false };
        const selection = await Z.chooseBlindAction(request);
        if (!selection) return;
        if (selection.awake) return Z.request(request, "awake");
        const { player } = request;
        const { material, declaration, targets, mode, free } = selection;
        const modeOK = Z.allowed(player, mode) && (mode === "normal" || Z.shown(material, player));
        const nameOK = !free || Z.matchesDeclaration(declaration, material, player);
        if (!modeOK || !nameOK || !Z.validate(request, player, material, targets)) {
            await player.showCards([material], "庄周确认提交的牌");
            await Z.expel(player, !nameOK ? "记错了牌名或装备类别" : "提交的牌、使用方式或目标不合法");
            return;
        }
        await Z.useSelection(request, selection, mode, null);
    };
    // 其他效果要求选目标时，也在固定的想象座位上点选，不打开按存活情况筛选的名单。
    Z.pickBlindTargets = (title, items, cancel) => new Promise(resolve => {
        if (Z.modal || Z.interaction) throw new Error("庄周选择窗口重入");
        Z.mount();
        Z.drawScene();
        Z.interaction = { targets: true };
        Z.syncSurface(true);
        const selected = [];
        const actions = document.createElement("div");
        actions.className = "zz-actions";
        const heading = document.createElement("div");
        heading.className = "zz-prompt";
        heading.textContent = title;
        const controls = document.createElement("div");
        controls.className = "zz-controls";
        actions.append(heading, controls);
        Z.stage.appendChild(actions);
        const finish = value => { Z.interaction = null; Z.refresh(); resolve(value); };
        // items 是调用者提供的固定座位，不读取目标的任何实时字段。
        Z.seatButtons.forEach((button, target) => button.onclick = () => {
            if (!items.includes(target)) return;
            const index = selected.indexOf(target);
            if (index < 0) selected.push(target); else selected.splice(index, 1);
            button.classList.toggle("zz-selected", index < 0);
        });
        Z.sceneButton(controls, "确定", () => finish(selected.slice()), "zz-primary");
        if (cancel) Z.sceneButton(controls, "取消", () => finish(null), "zz-quiet");
    });

    Z.useSelection = async (request, selection, mode, frame) => {
        const player = request.player;
        const respond = request.name === "chooseToRespond";
        const { material, targets } = selection;
        let token, card;
        if (mode !== "normal") {
            token = Z.makeToken(player, mode, material, frame);
            card = Z.makeCard(token);
        } else card = get.autoViewAs(material, [material]);
        request.result = {
            bool: true, card, targets,
            cards: token ? (token.zoneTransfer ? [material] : []) : [material],
        };
        // 无懈等只收集结果的询问，真正翻面与收尾由 useCard 入口负责。
        if (request.nouse || request.chooseonly) {
            if (token) {
                const outer = request.getParent("_wuxie") || request.parent;
                outer?.insertAfter?.(async function (event) {
                    const z = lib.xd_utils.zhuangzhou;
                    if (!event.token.used) await z.complete(event.token);
                }, { token, player, forceDie: true });
            }
            return;
        }
        if (respond) {
            request.onresult?.(request.result);
            const next = player.respond([material], card, request.animate, request.source);
            next.respondTo = request.respondTo || (request.parent?.card ? [request.parent.player, request.parent.card] : undefined);
            if (request.noOrdering) next.noOrdering = true;
            await next;
        } else {
            const use = player.useResult(request.result, request);
            await use;
            // async content 不会像本体分步 chooseToUse 那样自动传递子事件的 result。
            // 【闪】的 "shaned" 必须来自 useCard.result，不能只读询问的旧 _result。
            request._result = use.result;
            if (use.result !== undefined) request.result.result = use.result;
            if (token && !token.used) request.result.bool = false;
        }
        return;
    };

    Z.request = async (request, initialMode = null) => {
        const player = request.player;
        const respond = request.name === "chooseToRespond";
        if (request.responded) return;
        request.result = { bool: false };
        if (!Z.alive(player)) return;
        if (Z.blind(player) && !initialMode) return Z.blindRequest(request);
        if (respond && !Z.blind(player)) {
            await Z.nativeRequest(request);
            return;
        }

        while (Z.alive(player)) {
            const modes = ["normal"];
            if (!respond) {
                // 闭眼不按手牌明暗状态隐藏技能按钮，避免泄露手牌信息。
                if (Z.allowed(player, "dream") && (Z.blind(player) || player.getCards("h").some(c => Z.shown(c, player)))) modes.push("dream");
                if (Z.allowed(player, "awake") && Z.state(player).closed > 0) modes.push("awake");
            }
            const labels = { normal: respond ? "正常打出" : "正常使用", dream: "梦：盖回手牌并使用", awake: "醒：睁眼后明置手牌并使用" };
            const mode = initialMode || await Z.choose(respond ? "请选择打出方式" : "请选择使用方式", modes, modes.map(m => labels[m]));
            initialMode = null;
            if (!mode) return;
            if (mode === "normal" && !Z.blind(player)) {
                if (await Z.nativeRequest(request)) return;
                continue;
            }
            let frame = null;
            if (mode === "awake") {
                // 作者纠正：发动【醒】时先无条件睁开双眼；有没有牌可明置/可使用，只能在睁眼之后判断。
                if (!await Z.yes("发动【醒】并睁开双眼？睁眼后再选择要明置并使用的牌。")) {
                    if (Z.blind(player)) return Z.blindRequest(request);
                    continue;
                }
                frame = Z.begin(player, mode);
            }
            let selection;
            while (true) {
                selection = await Z.chooseAction(request, mode, !!frame);
                if (!selection) break;
                const { material, targets, blind } = selection;
                const modeOK = mode === "normal" || Z.shown(material, player) === (mode === "dream");
                if (modeOK && Z.validate(request, player, material, targets)) break;
                if (blind) {
                    // 提交后公开实际牌，错误立即可知；不再使用“声明假牌、弃牌时验真”的机制。
                    await player.showCards([material], "庄周提交的牌");
                    await Z.expel(player, modeOK ? "提交的牌或目标不合法" : "不能对这张手牌执行所选的明暗翻转");
                    return;
                }
                await Z.choose("这次选择不符合用牌要求，请重新选择", [true], ["返回选择"], false);
            }
            if (!selection) {
                // 【醒】已经先睁眼；此后若无法/不再完成明置用牌，就按技能“否则”结算，不能把睁眼回滚。
                if (frame && !frame.finished) {
                    Z.fail(frame);
                    Z.finish(frame);
                }
                continue;
            }
            await Z.useSelection(request, selection, mode, frame);
            if (frame && !frame.finished && request.result?.bool === false) {
                Z.fail(frame);
                Z.finish(frame);
            }
            return;
        }
    };

    // ─────────────────────────────────────────────────────────────
    // 庄周 V2.7.1 Blind Broker：Legality-First + 原生卡牌 UI
    // 核心：闭眼不是猜牌考试。庄周自由选择真实手牌/目标，按下确定后才用真实规则裁判。
    // 合规则交回原生提交；不合规则判负离场；UNSUPPORTED 只代表兼容性未知，绝不误罚。
    // ─────────────────────────────────────────────────────────────
    Z.v2Debug = (...args) => {
        try { console.log("[庄周V2原型]", ...args); } catch (e) {}
    };
    Z.v2Notice = text => {
        Z.v2Debug(text);
        if (!Z.v274SafeTestMode) {
            // 正式版：调试用的合规回执不写进战报，其余提示去掉“测试”字样。
            if (/^VALID/.test(text)) return;
            if (/^UNSUPPORTED/.test(text)) text = "这次闭眼操作无法判断是否合规，不处罚也不提交；请换一张牌或取消。";
        }
        try { game.log(Z.v274SafeTestMode ? "【庄周V2测试】" : "【庄周】", text); } catch (e) {}
    };
    Z.v2EnsureStyle = () => {
        if (typeof document === "undefined" || document.getElementById("xd-zz-v2-proto-style")) return;
        const style = document.createElement("style");
        style.id = "xd-zz-v2-proto-style";
        style.textContent = `
            .xd-zz-v2-proto-selected { box-shadow: 0 0 0 3px rgba(255,255,255,.92) inset, 0 0 12px rgba(0,0,0,.75) !important; }
            /* 测试版：真实手牌仍负责点击，但闭眼时正面本体彻底透明；原生 fake-card 牌背负责视觉。
               这样手牌重排时即使覆盖层慢一帧，也不会泄漏刚补位牌的正面。 */
            .xd-zz-native-under-mask { opacity:0 !important; }
            ${Z.v274SafeTestMode ? '.xd-zz-v2-proto-active::after { content:"V2.7.16 意象手动标记测试"; position:absolute; left:50%; top:8px; transform:translateX(-50%); z-index:20; pointer-events:none; padding:4px 9px; border-radius:10px; background:rgba(0,0,0,.72); color:white; font-size:13px; }' : ''}
            /* 自己在庄周闭眼选择中仍是一名可以点选的目标；只强化操作反馈，不透露是否合法。 */
            .player.xd-zz-v2-proto-self-selected,
            .xd-zz-v2-proto-self-selected.player {
                outline: 4px solid #7ef4ff !important;
                outline-offset: -3px !important;
                box-shadow: 0 0 0 3px rgba(1,32,45,.95) inset, 0 0 16px 5px rgba(90,236,255,.96) !important;
            }
            .xd-zz-v2-proto-self-selected.player .avatar,
            .xd-zz-v2-proto-self-selected.player .avatar2 {
                box-shadow: 0 0 0 3px #7ef4ff, 0 0 14px 4px rgba(90,236,255,.9) !important;
            }
        `;
        document.head.appendChild(style);
    };
    // V2.7.2：闭眼仍直接操作“真实手牌 DOM”，但视觉遮蔽改为本体原生 blank fake-card 覆盖层。
    // 2.7.1 直接往真实牌加 infohidden/infoflip，在部分原生/美化 UI 中并不会稳定显示成牌背；
    // 这里不再自绘卡背，而是调用无名杀自己的 game.createFakeCards(card, true) 生成原生空白牌背。
    // fake card 仅负责视觉，pointer-events:none；真正的点击仍落在下面那张真实手牌上。
    // V2.7.4 仅用于实机回归：正式版必须关闭。
    // INVALID 仍会被判定出来，但测试时不直接把玩家踢出游戏，便于连续验证。
    Z.v274SafeTestMode = ZHUANGZHOU_TEST_SCAFFOLD;
    Z.v274TestPeek = false;
    Z.v274TestPeekControl = null;
    Z.v274CloseTestPeekControl = () => {
        if (Z.v274TestPeekControl) {
            try { Z.v274TestPeekControl.close?.(); } catch (e) {
                try { Z.v274TestPeekControl.remove?.(); } catch (e2) {}
            }
        }
        Z.v274TestPeekControl = null;
        Z.v274TestPeek = false;
    };
    Z.v274RefreshTestPeekControl = player => {
        if (!(Z.v274SafeTestMode && Z.v2proto && player && Z.local(player) && Z.blind(player) && Z.alive(player))) {
            Z.v274CloseTestPeekControl();
            return;
        }
        const label = Z.v274TestPeek ? "测试：恢复闭眼" : "测试：窥视手牌";
        if (Z.v274TestPeekControl?._xdZZPeekLabel === label && Z.v274TestPeekControl.isConnected) return;
        if (Z.v274TestPeekControl) {
            try { Z.v274TestPeekControl.close?.(); } catch (e) {}
        }
        const control = ui.create.control(label, link => {
            if (link !== label) return;
            Z.v274TestPeek = !Z.v274TestPeek;
            Z.v274RefreshTestPeekControl(player);
            Z.v27SyncNativeHandMask?.(player);
        });
        control._xdZZPeekLabel = label;
        Z.v274TestPeekControl = control;
    };

    Z.v27NativeMaskedCards = new Map();
    Z.v272NativeBackHost = null;
    Z.v272EnsureBackHost = () => {
        if (typeof document === "undefined") return null;
        if (Z.v272NativeBackHost?.isConnected) return Z.v272NativeBackHost;
        const host = document.createElement("div");
        host.id = "xd-zz-native-back-host";
        Object.assign(host.style, {
            position: "fixed",
            left: "0",
            top: "0",
            width: "100vw",
            height: "100vh",
            pointerEvents: "none",
            zIndex: "2147483000",
            overflow: "visible",
        });
        document.documentElement.appendChild(host);
        Z.v272NativeBackHost = host;
        return host;
    };
    Z.v272CreateNativeBack = card => {
        let fake = null;
        try {
            if (typeof game.createFakeCards === "function") {
                fake = game.createFakeCards(card, true)?.[0] || null;
            }
        } catch (e) {
            Z.v2Debug?.("createFakeCards(blank) failed", e);
        }
        if (!fake) {
            // 兼容兜底：仍然克隆玩家当前无名杀自己的卡牌 DOM，绝不绘制庄周专用卡背。
            try {
                fake = card.cloneNode(true);
            } catch (e) {
                return null;
            }
        }
        // 无论来源如何，都使用无名杀本体“未知牌/牌背”状态。
        fake.classList?.add("infohidden", "infoflip", "xd-zz-native-blank-overlay");
        fake.classList?.remove("selected", "selectable", "glow", "target");
        fake.style.pointerEvents = "none";
        fake.setAttribute?.("aria-hidden", "true");
        return fake;
    };
    Z.v272SyncBackGeometry = (card, fake) => {
        if (!card?.getBoundingClientRect || !fake?.style) return;
        const rect = card.getBoundingClientRect();
        if (!rect.width || !rect.height) {
            if (fake.style.display !== "none") fake.style.display = "none";
            fake._xd_zz_lastRect = null;
            return;
        }
        const prev = fake._xd_zz_lastRect;
        if (prev && prev[0] === rect.left && prev[1] === rect.top &&
            prev[2] === rect.width && prev[3] === rect.height && fake.style.display !== "none") return;
        fake._xd_zz_lastRect = [rect.left, rect.top, rect.width, rect.height];
        fake.style.display = "";
        fake.style.position = "fixed";
        fake.style.left = rect.left + "px";
        fake.style.top = rect.top + "px";
        fake.style.width = rect.width + "px";
        fake.style.height = rect.height + "px";
        fake.style.margin = "0";
        fake.style.transform = "none";
        fake.style.transformOrigin = "center center";
        fake.style.zIndex = "2147483001";
    };
    Z.v27MaskNativeCard = card => {
        if (!card?.classList || Z.v27NativeMaskedCards.has(card)) return;
        const fake = Z.v272CreateNativeBack(card);
        if (!fake) return;
        const host = Z.v272EnsureBackHost();
        if (!host) return;
        host.appendChild(fake);
        card.classList.add("xd-zz-native-under-mask");
        Z.v27NativeMaskedCards.set(card, { fake });
        Z.v272SyncBackGeometry(card, fake);
    };
    Z.v27UnmaskNativeCard = card => {
        const entry = Z.v27NativeMaskedCards.get(card);
        if (!entry) return;
        try {
            if (typeof game.deleteFakeCards === "function") game.deleteFakeCards(entry.fake);
            else entry.fake?.delete?.();
        } catch (e) {
            try { entry.fake?.remove?.(); } catch (e2) {}
        }
        try { card?.classList?.remove("xd-zz-native-under-mask"); } catch (e) {}
        Z.v27NativeMaskedCards.delete(card);
    };
    Z.v27UnmaskAllNativeCards = () => {
        for (const card of Array.from(Z.v27NativeMaskedCards.keys())) Z.v27UnmaskNativeCard(card);
        if (Z.v272NativeBackHost && !Z.v272NativeBackHost.childElementCount) {
            try { Z.v272NativeBackHost.remove(); } catch (e) {}
            Z.v272NativeBackHost = null;
        }
    };
    Z.v27SyncNativeHandMask = player => {
        if (!player) {
            Z.v27UnmaskAllNativeCards();
            return;
        }
        const hand = new Set(player.getCards?.("h") || []);
        // v308：木牛流马里的牌（特殊区，但本体显示在手牌栏里）闭眼时同样盖牌背。
        for (const card of player.getCards?.("s") || []) {
            const parent = card?.parentNode;
            if (parent && (parent === player.node?.handcards1 || parent === player.node?.handcards2)) hand.add(card);
        }
        // v305：闭眼手选弃牌且可弃装备时，本人装备区的真实牌也盖原生牌背。
        const equipPick = player === game.me && !!Z.v305EquipPickActive?.(player);
        const equips = equipPick ? player.getCards?.("e") || [] : [];
        for (const card of equips) hand.add(card);
        // 询问结束后先收起装备区，再撤牌背；放开装备区则要等牌背盖好之后（见下方）。
        if (!equipPick && player === game.me) Z.v305SyncEquipPickClass?.();
        for (const card of Array.from(Z.v27NativeMaskedCards.keys())) {
            if (!hand.has(card)) Z.v27UnmaskNativeCard(card);
        }
        const blindActive = Z.v2proto && Z.local(player) && Z.blind(player) && Z.alive(player);
        if (blindActive) Z.v274RefreshTestPeekControl(player);
        const shouldMask = blindActive && !Z.v274TestPeek;
        if (!shouldMask) {
            Z.v27UnmaskAllNativeCards();
            return;
        }
        for (const card of hand) {
            Z.v27MaskNativeCard(card);
            const entry = Z.v27NativeMaskedCards.get(card);
            if (entry?.fake) Z.v272SyncBackGeometry(card, entry.fake);
            // 装备牌选中时不会像手牌那样上移，真实牌又是透明的，所以在牌背上标出选中。
            if (equips.includes(card) && entry?.fake) {
                entry.fake.classList.toggle("xd-zz-v2-proto-selected", !!card.classList?.contains("selected"));
            }
        }
        if (equipPick) Z.v305SyncEquipPickClass?.();
    };
    Z.v272StartBackTracking = () => {
        if (Z.v272Tracking) return;
        Z.v272Tracking = true;
        const tick = () => {
            if (!Z.v272Tracking) return;
            const player = game.me;
            const active = Z.v2proto && player && Z.local(player) && Z.blind(player) && Z.alive(player) && !Z.ended;
            if (!active) {
                Z.v272Tracking = false;
                Z.v301TeardownGuanshi?.();
                Z.v27UnmaskAllNativeCards();
                Z.v226StopDreamReport?.();
                Z.v274CloseTestPeekControl();
                return;
            }
            Z.v27SyncNativeHandMask(player);
            Z.v227SyncOwnEquipMask?.();
            Z.v215SyncImagery?.(player);
            Z.v241SyncDreamWallpaper?.();
            requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
    };

    Z.v2ReplaceArray = (array, values) => {
        array.length = 0;
        array.push(...values);
    };
    Z.v2SnapshotSelected = () => ({
        buttons: ui.selected.buttons.slice(),
        cards: ui.selected.cards.slice(),
        targets: ui.selected.targets.slice(),
    });
    Z.v2RestoreSelected = snapshot => {
        Z.v2ReplaceArray(ui.selected.buttons, snapshot.buttons);
        Z.v2ReplaceArray(ui.selected.cards, snapshot.cards);
        Z.v2ReplaceArray(ui.selected.targets, snapshot.targets);
    };
    Z.v2GetRange = value => {
        const range = get.select(value);
        return Array.isArray(range) ? range.slice() : [range, range];
    };
    Z.v2CountInRange = (count, range) =>
        count >= range[0] && (range[1] < 0 || count <= range[1]);
    // V2.7：闭眼不再声明牌名，也不根据真实牌的目标结构提前限制操作。
    // 只要庄周选中了一张手牌，就允许按“确定”；真正的合法性统一在提交后裁判。
    Z.v27IntentStructurallyComplete = session => !!session?.intent?.card;
    Z.v2CloseOwnConfirm = session => {
        const node = ui.confirm;
        if (!node || node._xdZZBlindSession !== session) return;
        try { node.close?.(); } catch (e) {
            try { node.remove?.(); } catch (e2) {}
        }
        try {
            if (ui.confirm === node) ui.confirm = undefined;
        } catch (e) {}
    };

    // V2.7 正式废弃 V2.3~V2.6 的“声明牌名 / 声明目标结构”产品逻辑。
    // 只保留一个清理函数，确保从旧原型切换时不会残留声明 Dialog / Control。
    Z.v27RemoveLegacyDeclarePanel = session => {
        const dialog = session?.declarePanel;
        if (dialog) {
            try { dialog.close?.(); } catch (e) { try { dialog.remove?.(); } catch (e2) {} }
        }
        const control = session?.declareControl;
        if (control) {
            try { control.close?.(); } catch (e) { try { control.remove?.(); } catch (e2) {} }
        }
        const keyHandler = session?.declareKeyHandler;
        if (keyHandler) {
            try { document.removeEventListener("keydown", keyHandler, true); } catch (e) {}
        }
        if (session) {
            session.declarePanel = null;
            session.declareControl = null;
            session.declareKeyHandler = null;
            session.declareScrollBox = null;
        }
    };

    // V2.7：不再识别/要求“声明牌名”。
    // 闭眼下只区分当前原生询问属于主动使用、响应打出、响应性使用，
    // 以及是否正在通过【梦】/【醒】使用牌；所有牌名与目标合法性均留到最终 Validator。
    Z.v27Profile = event => {
        if (!event || !["chooseToUse", "chooseToRespond"].includes(event.name)) return null;
        if (event.skill && !["xd_meng", "xd_xing"].includes(event.skill)) return null;
        let cardRange;
        try { cardRange = Z.v2GetRange(event.selectCard); } catch (e) { return null; }
        // 当前 BlindBroker 仍以“一张实体手牌”为事务单位；复杂多牌 viewAs 留作 UNSUPPORTED。
        if (!cardRange || cardRange[0] !== 1 || cardRange[1] !== 1) return null;
        if (event.skill === "xd_meng") return { kind: "dream", mode: "dream" };
        if (event.skill === "xd_xing") return { kind: "awake", mode: "awake" };
        if (event.name === "chooseToRespond") return { kind: "respond" };
        if (event.type === "phase") return { kind: "phase" };
        return { kind: "responseUse" };
    };

    // 原生检查会维护选择标记、缓存和确认控件；这里只在提交后同步借用它，
    // 不执行出牌、不运行 checkEnd 的显示/自动确认钩子，结束后恢复闭眼界面。
    Z.v294ValidateNative = (session, material, intendedTargets) => {
        const event = session.event;
        const player = event.player;
        if (Z.v294NativeValidation) return { status: "UNSUPPORTED", stage: "NATIVE_CHECK_REENTRANT" };
        if (typeof game.check !== "function" || typeof game.Check?.card !== "function" ||
            typeof game.callHook !== "function" || !material.classList?.contains) {
            return { status: "UNSUPPORTED", stage: "NATIVE_CHECK_UNAVAILABLE" };
        }
        if (event.filterButton) return { status: "UNSUPPORTED", stage: "NATIVE_BUTTON_SELECTION" };
        if (intendedTargets.length !== new Set(intendedTargets).size) {
            return { status: "INVALID", stage: "DUPLICATE_TARGET" };
        }
        if (event.name === "chooseToRespond" && intendedTargets.length) {
            return { status: "INVALID", stage: "RESPOND_UNEXPECTED_TARGET" };
        }

        const groups = {
            button: event.dialog?.buttons || [],
            card: player.getCards(event.position || "h"),
            target: [...game.players, ...(game.dead || [])],
        };
        const nodes = new Set([...groups.button, ...groups.card, ...groups.target, ui.arena, player.node?.equips]);
        for (const target of groups.target) {
            nodes.add(target.instance);
            nodes.add(target.node?.action);
        }
        const marks = ["selected", "selectable", "selecting", "tempnoe", "popequip", "thunder"];
        const nodeState = [...nodes].filter(node => node?.classList).map(node => ({
            node,
            className: node.getAttribute?.("class"),
            marks: marks.map(name => node.classList.contains(name)),
            cssText: typeof node.style?.cssText === "string" ? node.style.cssText : undefined,
            actionHTML: groups.target.some(target => target.node?.action === node) ? node.innerHTML : undefined,
        }));
        const fields = [];
        const saveField = (object, key) => {
            fields.push({ object, key, descriptor: Object.getOwnPropertyDescriptor(object, key) });
        };
        for (const key of ["_buttonChoice", "_cardChoice", "_targetChoice", "_skillChoice", "_checked",
            "targetprompt2", "cardChooseAll", "buttonChooseAll"]) saveField(event, key);
        for (const key of ["noconfirm", "multitarget", "imchoosing"]) saveField(_status, key);
        for (const key of ["auto_confirm", "cardtempname"]) saveField(lib.config, key);
        for (const key of ["ok", "cancel"]) saveField(ui.click, key);
        for (const key of ["callHook", "uncheck"]) saveField(game, key);
        saveField(game.Check, "confirm");
        saveField(Z, "v294NativeValidation");

        try {
            Z.v294NativeValidation = { event, session };
            for (const key of ["_buttonChoice", "_cardChoice", "_targetChoice", "_skillChoice"]) delete event[key];
            event.targetprompt2 = [];
            event.cardChooseAll = event.buttonChooseAll = undefined;
            _status.noconfirm = true;
            lib.config.auto_confirm = false;
            lib.config.cardtempname = "off";
            ui.click.ok = ui.click.cancel = () => {};
            game.Check.confirm = () => {};
            const nativeCallHook = game.callHook;
            game.callHook = function (name, ...args) {
                // checkEnd 在原生布尔判定完成后才运行；这里跳过其 UI 刷新和自动出牌。
                if (name === "checkEnd") return;
                return nativeCallHook.call(this, name, ...args);
            };
            game.uncheck = (...types) => {
                // 检查失败时仍清空后续选择；不拆除桌面的提示节点、拖拽线和控件。
                if (!types.length) types = ["button", "card", "target"];
                for (const type of types) {
                    if (!groups[type]) throw new Error("Unsupported native uncheck type");
                    ui.selected[type + "s"].length = 0;
                    for (const node of groups[type]) node.classList?.remove("selected", "selectable");
                }
            };
            for (const type of ["button", "card", "target"]) {
                ui.selected[type + "s"].length = 0;
                for (const node of groups[type]) node.classList?.remove("selected", "selectable");
            }

            const nativeCheck = () => {
                if (get.event() !== event) throw new Error("Native check event changed");
                const ok = game.check(event);
                if (typeof ok !== "boolean" || get.event() !== event) throw new Error("Native check did not return a stable verdict");
                return ok;
            };
            // 先让完整原生检查生成可点击项，再重放点击；不能把非法牌预先标为 selected。
            nativeCheck();
            if (!material.classList.contains("selectable")) return { status: "INVALID", stage: "NATIVE_CARD" };
            ui.selected.cards.push(material);
            material.classList.add("selected");
            const check = () => {
                const ok = nativeCheck();
                if (ui.selected.cards.length !== 1 || ui.selected.cards[0] !== material || ui.selected.buttons.length) {
                    throw new Error("Native check changed the single-card selection");
                }
                return ok;
            };
            let ok = check();
            if (!get.card()) return { status: "UNSUPPORTED", stage: "NO_CANONICAL_CARD" };
            if (event.name === "chooseToRespond") {
                if (!ok) return { status: "INVALID", stage: "NATIVE_CHECK" };
                if (ui.selected.targets.length) return { status: "UNSUPPORTED", stage: "NATIVE_RESPOND_TARGETS" };
                return { status: "VALID", plan: { cards: [material], targets: [], buttons: [] } };
            }

            let targetRange = Z.v2GetRange(event.selectTarget);
            if (targetRange[1] >= 0) {
                if (targetRange[0] === 0 && targetRange[1] === 0 && intendedTargets.length) {
                    return { status: "INVALID", stage: "UNEXPECTED_TARGET", targetRange };
                }
                for (const target of intendedTargets) {
                    // 原生先计算下一个可点击目标；按玩家的实际点击顺序逐个重放。
                    if (!target?.classList?.contains("selectable") || ui.selected.targets.includes(target)) {
                        return { status: "INVALID", stage: "NATIVE_TARGET", targetRange };
                    }
                    ui.selected.targets.push(target);
                    target.classList.add("selected");
                    ok = check();
                    targetRange = Z.v2GetRange(event.selectTarget);
                    if (targetRange[1] < 0) break;
                }
            }
            if (targetRange[1] < 0 && intendedTargets.length &&
                (intendedTargets.length !== ui.selected.targets.length ||
                    intendedTargets.some(target => !ui.selected.targets.includes(target)))) {
                return { status: "INVALID", stage: "AUTO_TARGET_MISMATCH", targetRange };
            }
            if (!ok) return { status: "INVALID", stage: "NATIVE_CHECK", targetRange };
            return { status: "VALID", targetRange,
                plan: { cards: [material], targets: ui.selected.targets.slice(), buttons: [] } };
        } catch (error) {
            Z.v2Debug("Native validator exception", error);
            return { status: "UNSUPPORTED", stage: "NATIVE_CHECK_EXCEPTION", error };
        } finally {
            for (let index = fields.length - 1; index >= 0; index--) {
                const { object, key, descriptor } = fields[index];
                if (descriptor) Object.defineProperty(object, key, descriptor);
                else delete object[key];
            }
            for (const { node, className, marks: savedMarks, cssText, actionHTML } of nodeState) {
                if (className !== undefined && node.setAttribute) {
                    if (className === null) node.removeAttribute?.("class");
                    else node.setAttribute("class", className);
                } else {
                    marks.forEach((name, index) => node.classList[savedMarks[index] ? "add" : "remove"](name));
                }
                if (cssText !== undefined) node.style.cssText = cssText;
                if (actionHTML !== undefined) node.innerHTML = actionHTML;
            }
        }
    };

    // 只保留庄周的前置条件和零目标铁索重铸；一般用牌/响应交给原生检查。
    Z.v2ValidateSingle = session => {
        const event = session.event;
        const player = event.player;
        const material = session.intent.card;
        const intendedTargets = session.intent.targets.slice();
        if (!material) return { status: "INVALID", stage: "STRUCTURE_NO_CARD" };
        if (get.event() !== event) return { status: "UNSUPPORTED", stage: "STALE_EVENT" };
        const old = Z.v2SnapshotSelected();
        session.validating = true;
        try {
            Z.v2ReplaceArray(ui.selected.buttons, []);
            Z.v2ReplaceArray(ui.selected.cards, []);
            Z.v2ReplaceArray(ui.selected.targets, []);
            if (!player.getCards(event.position || "h").includes(material)) return { status: "INVALID", stage: "CARD_SOURCE" };
            if (player.isOut()) return { status: "INVALID", stage: "PLAYER_OUT" };
            if (session.profile?.mode) {
                const mode = session.profile.mode;
                if (!Z.allowed(player, mode)) return { status: "INVALID", stage: "MODE_LOCKED" };
                if (mode === "awake" && !Z.v228CanAwake(player, event)) return { status: "INVALID", stage: "AWAKE_WITHOUT_CLOSED_EYE" };
                if (Z.shown(material, player) !== (mode === "dream")) return { status: "INVALID", stage: "MODE_CARD_VISIBILITY" };
            }
            if (event.name === "chooseToUse" && event.type === "phase" && !event.skill &&
                !session.profile?.mode && intendedTargets.length === 0 && get.name(material, player) === "tiesuo") {
                if (typeof player.canRecast !== "function" || !player.canRecast(material)) {
                    return { status: "INVALID", stage: "TIESUO_RECAST_NOT_ALLOWED" };
                }
                ui.selected.cards.push(material);
                const cardRange = Z.v2GetRange(event.selectCard);
                if (!Z.v2CountInRange(ui.selected.cards.length, cardRange)) {
                    return { status: "INVALID", stage: "TIESUO_RECAST_CARD_RANGE", cardRange };
                }
                const canonicalCard = get.card();
                if (!canonicalCard || get.name(canonicalCard, player) !== "tiesuo") {
                    return { status: "UNSUPPORTED", stage: "TIESUO_RECAST_TRANSFORMED_CARD" };
                }
                return { status: "VALID", plan: { recast: true, cards: [material], targets: [], buttons: [] } };
            }
            return Z.v294ValidateNative(session, material, intendedTargets);
        } catch (error) {
            Z.v2Debug("Validator exception", error);
            return { status: "UNSUPPORTED", stage: "EXCEPTION", error };
        } finally {
            Z.v2RestoreSelected(old);
            session.validating = false;
        }
    };

    Z.v2ClearIntent = session => {
        session.intent.card?.classList?.remove("xd-zz-v2-proto-selected");
        const maskedEntry = session.intent.card && Z.v27NativeMaskedCards?.get(session.intent.card);
        maskedEntry?.fake?.classList?.remove("xd-zz-v2-proto-selected");
        for (const target of session.intent.targets || []) target?.classList?.remove("xd-zz-v2-proto-selected", "xd-zz-v2-proto-self-selected");
        session.intent.card = null;
        if (session.intent.targets) session.intent.targets.length = 0;
        Z.v27RemoveLegacyDeclarePanel(session);
    };
    Z.v2RestoreHandlers = session => {
        const replace = session.event.custom?.replace;
        if (!replace) return;
        for (const key of ["card", "target", "confirm"]) {
            if (replace[key] === session.installed[key]) {
                if (session.original[key] == null) delete replace[key];
                else replace[key] = session.original[key];
            }
        }
    };
    Z.v2DestroySession = (session, reason = "destroy") => {
        if (!session || session.destroyed) return;
        session.destroyed = true;
        try { Z.v2Sessions.delete(session.event); } catch (e) {}
        Z.v2ClearIntent(session);
        Z.v2RestoreHandlers(session);
        Z.v2CloseOwnConfirm(session);
        Z.v2ActiveSessions.delete(session);
        try { ui.arena?.classList.remove("xd-zz-v2-proto-active"); } catch (e) {}
        Z.v2Debug("session destroyed", reason, session.event?.name);
    };
    Z.v2DestroyAll = reason => {
        for (const session of Array.from(Z.v2ActiveSessions)) Z.v2DestroySession(session, reason);
    };
    Z.v2Render = session => {
        if (!session || session.destroyed || session.suspended || get.event() !== session.event) return;
        Z.v2EnsureStyle();
        ui.arena?.classList.add("xd-zz-v2-proto-active");

        const player = session.event.player;
        Z.v27SyncNativeHandMask(player);
        Z.v272StartBackTracking?.();
        // game.check() 可以继续计算真实合法性，但绝不能把真实选择结果留成视觉/操作侧信道。
        // 每次 checkEnd 后都清空 native selection，DreamIntent 才是闭眼期间唯一可见的选择状态。
        Z.v2ReplaceArray(ui.selected.buttons, []);
        Z.v2ReplaceArray(ui.selected.cards, []);
        Z.v2ReplaceArray(ui.selected.targets, []);
        for (const card of player.getCards(session.event.position || "h")) {
            card.classList.remove("selectable", "selected");
            if (card !== session.intent.card) card.classList.remove("xd-zz-v2-proto-selected");
        }
        const intendedTargets = new Set(session.intent.targets || []);
        for (const target of [...game.players, ...(game.dead || [])]) {
            target.classList.remove("selectable", "selected", "xd-zz-v2-proto-self-selected");
            if (!intendedTargets.has(target)) target.classList.remove("xd-zz-v2-proto-selected", "xd-zz-v2-proto-self-selected");
        }
        session.intent.card?.classList?.add("xd-zz-v2-proto-selected");
        for (const [realCard, entry] of Z.v27NativeMaskedCards || []) {
            entry.fake?.classList?.toggle("xd-zz-v2-proto-selected", realCard === session.intent.card);
        }
        for (const target of intendedTargets) {
            target?.classList?.add("xd-zz-v2-proto-selected");
            if (target === session.event.player) target?.classList?.add("xd-zz-v2-proto-self-selected");
        }

        // V2.7：声明器彻底退出正式闭眼出牌流程。保留玩家当前无名杀的原生手牌、座位与确认控件。
        Z.v27RemoveLegacyDeclarePanel(session, false);

        // 只要选中一张牌就给“确定”。是否需要目标、目标对不对、牌当前能不能用，全部在提交后裁判。
        const confirm = ui.create.confirm(Z.v27IntentStructurallyComplete(session) ? "oc" : "c");
        const confirmNode = confirm || ui.confirm;
        if (confirmNode) confirmNode._xdZZBlindSession = session;
        if (ui.confirm) ui.confirm._xdZZBlindSession = session;
    };
    // 通过本体的 player.recast 真正执行重铸，而不是使用一张没有目标的牌。
    // chooseToUse 采用 cancel:true 重新进入本次询问，以便正常继续出牌阶段。
    Z.v2CommitTiesuoRecast = (session, plan) => {
        if (!session || session.destroyed || get.event() !== session.event) {
            Z.v2Notice("重铸前事件已变化：本次不处罚、不提交。");
            return;
        }
        const event = session.event;
        const player = event.player;
        const material = plan.cards?.[0];
        if (event.name !== "chooseToUse" || event.type !== "phase" ||
            event.skill || session.profile?.mode || !material ||
            !player.getCards(event.position || "h").includes(material) ||
            get.name(material, player) !== "tiesuo" || !player.canRecast?.(material)) {
            Z.v2Notice("重铸提交时条件已经变化：本次不处罚、不提交。");
            Z.v2ClearIntent(session);
            Z.v2Render(session);
            return;
        }
        session.suspended = true;
        Z.v2RestoreHandlers(session);
        Z.v2CloseOwnConfirm(session);
        Z.v2ClearIntent(session);
        Z.v27UnmaskNativeCard(material);
        Z.v2ActiveSessions.delete(session);
        session.destroyed = true;
        ui.arena?.classList.remove("xd-zz-v2-proto-active");
        Z.v2Debug("blind tiesuo recast", material);
        // 在当前 chooseToUse 恢复之前将原生重铸加入事件队列。
        player.recast(material);
        // 原生取消负责清理选牌 UI；紧接着恢复为成功但不使用牌的结果。
        // 本体 chooseToUse 的 cancel:true 分支会重新询问，出牌阶段不会因此结束。
        ui.click.cancel();
        event.result = { bool: true, cancel: true };
    };
    Z.v2Commit = (session, plan) => {
        if (plan?.recast) return Z.v2CommitTiesuoRecast(session, plan);
        if (!session || session.destroyed || get.event() !== session.event) {
            Z.v2Notice("提交前事件已变化：本次不处罚、不提交。");
            return;
        }
        session.suspended = true;
        Z.v2RestoreHandlers(session);
        Z.v2CloseOwnConfirm(session);
        Z.v2ClearIntent(session);
        Z.v2ReplaceArray(ui.selected.buttons, plan.buttons || []);
        Z.v2ReplaceArray(ui.selected.cards, plan.cards || []);
        Z.v2ReplaceArray(ui.selected.targets, plan.targets || []);
        // 提交前恢复真正要进入原生使用/响应动画的实体牌正面；其余闭眼手牌仍保持原生背面。
        // v308：技能本身把牌扣置、不公开（如【木牛流马】：不弃、不失去、不转化）时，牌一直保持背面。
        let keepHidden = false;
        try {
            const info = get.info(session.event.skill);
            keepHidden = !!(info && !info.viewAs && info.discard === false && info.lose === false &&
                (info.prepare == null || typeof info.prepare === "function" || ["give2", "throw2"].includes(info.prepare)));
        } catch (e) {}
        if (!keepHidden) for (const card of plan.cards || []) Z.v27UnmaskNativeCard(card);
        Z.v2ActiveSessions.delete(session);
        session.destroyed = true;
        ui.arena?.classList.remove("xd-zz-v2-proto-active");
        Z.v2Debug("native commit", plan);
        ui.click.ok();
    };
    Z.v2InstallSession = event => {
        const existing = Z.v2Sessions.get(event);
        if (existing && !existing.destroyed) {
            // v301：同一个询问里点【梦】或撤销技能会复用原会话；按当前 event.skill 刷新用途，
            // 不能沿用建会话时的 phase（否则【梦】+0目标铁索会误入普通重铸分支）。
            const current = Z.v27Profile(event);
            if (current) existing.profile = current;
            return existing;
        }
        if (existing?.destroyed) Z.v2Sessions.delete(event);
        event.custom ||= {};
        event.custom.replace ||= {};
        const replace = event.custom.replace;
        const original = { card: replace.card, target: replace.target, confirm: replace.confirm };
        // 最小原型不碰已有 replace；遇到冲突只记录并退回原生。
        if (["card", "target", "confirm"].some(key => typeof original[key] === "function")) {
            Z.v2Debug("replace conflict; prototype skips event", event, original);
            return null;
        }
        const profile = Z.v27Profile(event);
        if (!profile) return null;

        // 【醒】的“先睁眼”不再放在这里。
        // 原因：当前 chooseToUse 可能早已有一个普通 BlindBroker session；等重新安装 session 才睁眼会太晚，
        // 实机表现就会变成“闭眼选牌 -> 确定时才睁眼”。V2.7.7 改由独立 checkBegin 前置钩子处理。
        if (profile.mode === "awake" && Z.state(event.player).closed > 0) return null;

        const session = {
            event,
            profile,
            intent: { card: null, targets: [] },
            original,
            installed: {},
            declarePanel: null,
            declareControl: null,
            declareCategory: null,
            validating: false,
            suspended: false,
            destroyed: false,
        };
        session.installed.card = function (card) {
            if (session.destroyed || session.suspended || session.validating || get.event() !== event) return;
            const source = event.player.getCards(event.position || "h");
            if (!source.includes(card)) return;
            if (session.intent.card === card) {
                Z.v2ClearIntent(session);
            } else {
                session.intent.card?.classList?.remove("xd-zz-v2-proto-selected");
                for (const target of session.intent.targets) target?.classList?.remove("xd-zz-v2-proto-selected", "xd-zz-v2-proto-self-selected");
                session.intent.card = card;
                session.intent.targets.length = 0;
                card.classList.add("xd-zz-v2-proto-selected");
            }
            Z.v2Render(session);
        };
        session.installed.target = function (target) {
            if (session.destroyed || session.suspended || session.validating || get.event() !== event) return;
            // chooseToRespond 本体没有自由选目标这一步；其它 chooseToUse 一律允许庄周先点，最后再判是否合法。
            if (event.name === "chooseToRespond") return;
            if (![...game.players, ...(game.dead || [])].includes(target)) return;
            if (!session.intent.card) {
                Z.v2Notice("请先选一张手牌。闭眼时不会提前告诉你它是否需要目标。");
                return;
            }
            const targets = session.intent.targets;
            const index = targets.indexOf(target);
            if (index >= 0) {
                targets.splice(index, 1);
                target.classList.remove("xd-zz-v2-proto-selected", "xd-zz-v2-proto-self-selected");
            } else {
                targets.push(target);
                target.classList.add("xd-zz-v2-proto-selected");
            }
            Z.v2Render(session);
        };
        session.installed.confirm = function (ok) {
            if (session.destroyed || session.suspended || session.validating || get.event() !== event) return;
            if (!ok) {
                const hasUserIntent = !!session.intent.card || !!session.intent.targets.length;
                if (hasUserIntent) {
                    Z.v2ClearIntent(session);
                    Z.v2Render(session);
                    return;
                }
                // 空意图时交回本体取消/结束。
                session.suspended = true;
                Z.v27RemoveLegacyDeclarePanel(session);
                Z.v2RestoreHandlers(session);
                Z.v2CloseOwnConfirm(session);
                Z.v2ActiveSessions.delete(session);
                session.destroyed = true;
                ui.arena?.classList.remove("xd-zz-v2-proto-active");
                ui.click.cancel();
                return;
            }
            if (!Z.v27IntentStructurallyComplete(session)) {
                Z.v2Render(session);
                return;
            }
            const verdict = Z.v2ValidateSingle(session);
            Z.v2Debug("verdict", verdict);
            if (verdict.status === "VALID") {
                Z.v2Notice("VALID：本次闭眼操作符合真实游戏规则，交回原生提交。");
                Z.v2Commit(session, verdict.plan);
                return;
            }
            if (verdict.status === "UNSUPPORTED") {
                // 兼容性未知绝不能误罚玩家；留在当前询问中继续操作。
                Z.v2Notice("UNSUPPORTED：当前实现无法安全判断这次操作；不处罚、不提交。");
                Z.v2ClearIntent(session);
                Z.v2Render(session);
                return;
            }

            // INVALID 是真实规则错误。正式版会判负离场；V2.7.4 回归测试模式先保留在当前询问中，
            // 避免每测一个错误分支就被迫重开一局。
            const player = event.player;
            const debugStage = verdict.stage;
            if (Z.v274SafeTestMode) {
                let realName = "未知牌";
                try { realName = get.translation(get.name(session.intent.card, player)) || get.name(session.intent.card, player) || realName; } catch (e) {}
                Z.v2Notice(`TEST INVALID（正式版将判负）：真实牌【${realName}】，阶段 ${debugStage}`);
                Z.v2ClearIntent(session);
                Z.v2Render(session);
                return;
            }
            session.suspended = true;
            Z.v27RemoveLegacyDeclarePanel(session);
            Z.v2RestoreHandlers(session);
            Z.v2CloseOwnConfirm(session);
            Z.v2ClearIntent(session);
            Z.v2ActiveSessions.delete(session);
            session.destroyed = true;
            ui.arena?.classList.remove("xd-zz-v2-proto-active");
            Z.v2Debug("INVALID closed-eye action", debugStage, verdict);
            ui.click.cancel();
            Promise.resolve().then(() => Z.expel(player, "闭眼提交的用牌/响应不符合真实游戏规则"));
        };
        replace.card = session.installed.card;
        replace.target = session.installed.target;
        replace.confirm = session.installed.confirm;
        Z.v2Sessions.set(event, session);
        Z.v2ActiveSessions.add(session);
        Z.v2Debug("session installed", event);
        return session;
    };
    Z.v2EligibleEvent = event => {
        if (!(Z.v2proto && event && event.player === game.me && event.isMine?.() && Z.local(event.player) && Z.blind(event.player))) return false;
        return !!Z.v27Profile(event);
    };
    Z.v2CheckBegin = event => {
        if (Z.v294NativeValidation?.event === event) return;
        if (!Z.v2proto) return;
        // 一个新的本机选择事件出现时，清掉已经离开当前事件的测试 session。
        for (const session of Array.from(Z.v2ActiveSessions)) {
            if (session.event !== event && !session.suspended) Z.v2DestroySession(session, "stale-event");
        }
        if (!Z.v2EligibleEvent(event)) {
            const existing = Z.v2Sessions.get(event);
            if (existing && !existing.destroyed) Z.v2DestroySession(existing, "event-no-longer-eligible");
            return;
        }
        const session = Z.v2InstallSession(event);
        if (session && !session.validating && !session.suspended) Z.v2EnsureStyle();
    };
    Z.v2CheckEnd = event => {
        if (Z.v294NativeValidation?.event === event) return;
        if (!Z.v2proto || !Z.v2EligibleEvent(event)) return;
        const session = Z.v2Sessions.get(event);
        if (!session || session.validating || session.suspended || session.destroyed) return;
        Z.v2Render(session);
    };
    lib.hooks.checkBegin ||= [];
    lib.hooks.checkEnd ||= [];

    // V2.7.7【醒】顺序：点击技能以后、原生开始计算可选手牌以前，立即睁眼。
    // 这必须先于 BlindBroker 的 checkBegin 执行，否则旧的闭眼 session 会让玩家先在牌背状态下选牌。
    Z.awakeFirstCheckBegin = event => {
        if (Z.v294NativeValidation?.event === event) return;
        if (!event || event.name !== "chooseToUse" || event.skill !== "xd_xing") return;
        const player = event.player;
        if (!player || player !== game.me || !Z.local(player)) return;
        if (!Z.allowed(player, "awake") ||
            (Z.state(player).closed <= 0 && !Z.v228PendingAwake(player, event))) {
            // A previous 【醒】 was already spent. Native cancel may reuse this request;
            // discard its stale selected skill without starting another frame or use event.
            event.skill = null;
            return;
        }
        const pending = player._xd_zz_pendingAwake;
        if (pending?.request === event && !pending.cancelled &&
            pending.frame && !pending.frame.finished) return;

        // 技能已经由玩家点中；从这一刻起【醒】视为已经发动。先睁眼，再让本体展示真实手牌供选择。
        const frame = Z.begin(player, "awake");
        player._xd_zz_pendingAwake = { request: event, frame };
        Z.v243SyncAwakeButtons(player);
        Z.v2DestroyAll("awake-open-before-card-selection");
        Z.v2Debug("awake-first checkBegin: eyes opened before native card selection", event);
    };

    lib.hooks.checkBegin.unshift(Z.awakeFirstCheckBegin);
    lib.hooks.checkBegin.push(Z.v2CheckBegin);
    lib.hooks.checkEnd.push(Z.v2CheckEnd);
    lib.hooks.checkEnd.push(Z.v229AwakeSelectionReady);
    lib.hooks.checkEnd.push(Z.v242AwakeAfterCheck);
    // 每次原生游戏重新绘制技能栏后，再次移除“已睁眼”的【醒】残留按钮。
    lib.hooks.checkEnd.push(event => {
        if (Z.v294NativeValidation?.event === event) return;
        const player = event?.player;
        if (!player || player !== game.me || !Z.local(player)) return;
        Z.v243GuardNativeSkillClicks(player);
        Z.v243SyncAwakeButtons(player);
        Z.v245SyncOtherSkillButtons?.();
    });

    // 闭眼时的“从牌中挑牌”交还原生 AI 结算：只对庄周本人的本地选择事件生效。
    // 通过事件自己的 isMine 分流，保留本体的合法性过滤、结果结构、移动/弃置日志及动画。
    // 不接管 chooseToUse/chooseToRespond 或选目标，也不将一般的按钮选项误当作牌。
    // v280 例外：贯石斧必须由闭眼庄周本人决定是否发动、以及弃置哪些牌。
    // 随机选牌系统不能替玩家自动选择，否则会把“可发动”的贯石斧变成自动发动。
    // 只识别贯石斧相关的 chooseCard / chooseToDiscard 询问；其他随机选牌维持原逻辑。
    Z.v280IsGuanshiChoice = (event, kind) => {
        if (!event || (kind !== "chooseCard" && kind !== "chooseToDiscard")) return false;
        const hasGuanshi = value => {
            if (value == null) return false;
            if (Array.isArray(value)) return value.some(hasGuanshi);
            if (typeof value !== "string") return false;
            if (/guanshi/i.test(value) || value.includes("贯石斧")) return true;
            try {
                const translated = get.translation(value);
                return typeof translated === "string" && translated.includes("贯石斧");
            } catch (e) {
                return false;
            }
        };
        let current = event;
        for (let depth = 0; current && depth < 16; depth++) {
            if (
                hasGuanshi(current.skill) ||
                hasGuanshi(current.sourceSkill) ||
                hasGuanshi(current.logSkill) ||
                hasGuanshi(current.name) ||
                hasGuanshi(current.prompt) ||
                hasGuanshi(current.prompt2)
            ) return true;
            let parent = null;
            try { parent = current.getParent?.(); } catch (e) {}
            if (!parent || parent === current) break;
            current = parent;
        }
        return false;
    };

    // V2.8.4【火攻】：目标展示的真实牌面不能告诉闭眼庄周；随后弃同花色牌也不能由 AI 代选。
    // 这里不改【火攻】本体的结算、目标展示牌、真实花色或伤害，只改变庄周本机的可见信息与选择方式。
    Z.v284IsHuogongEvent = event => {
        if (!event) return false;
        if (event.name === "huogong") return true;
        try {
            const card = event.card;
            if (card && (get.name(card, event.player) || card.name) === "huogong") return true;
        } catch (e) {}
        return false;
    };
    Z.v284IsDirectHuogongChild = event => {
        if (!event) return false;
        try {
            const parent = event.getParent?.();
            if (parent && parent !== event && Z.v284IsHuogongEvent(parent)) return true;
        } catch (e) {}
        // 刚 createEvent 的极早阶段在个别版本上 getParent 尚不可用；此时当前事件就是直接父事件。
        try {
            if (_status?.event && _status.event !== event && Z.v284IsHuogongEvent(_status.event)) return true;
        } catch (e) {}
        return false;
    };
    Z.v284IsHuogongDiscardChoice = (event, player) => !!(
        event && event.name === "chooseToDiscard" && player && player === game.me &&
        Z.local(player) && Z.blind(player) && Z.v284IsDirectHuogongChild(event)
    );
    Z.v284PrepareHuogongDiscard = (event, player) => {
        if (!Z.v284IsHuogongDiscardChoice(event, player)) return false;
        if (event._xd_zz_v284HuogongDiscard) return true;
        event.custom ||= {};
        event.custom.replace ||= {};
        // 不覆盖别的扩展已经安装的 confirm 接管；遇到冲突宁可回退，不冒险破坏结算。
        if (typeof event.custom.replace.confirm === "function") return false;

        const realFilter = event.filterCard;
        event._xd_zz_v284HuogongDiscard = true;
        event._xd_zz_v284RealFilter = realFilter;
        // 原生 UI 仍负责“手动点一张牌”，但闭眼时不能提前用花色过滤告诉庄周哪张才正确。
        // chooseToDiscard 自己还会再叠加 cardDiscardable，所以不可弃置的牌依然不会变成候选。
        event.filterCard = () => true;

        const restore = () => {
            event.filterCard = realFilter;
            if (event.custom?.replace?.confirm === confirm) delete event.custom.replace.confirm;
        };
        const confirm = function (ok) {
            if (get.event?.() !== event) return;
            if (!ok) {
                restore();
                ui.click.cancel(Z.v307ConfirmButton());
                return;
            }
            const cards = ui.selected.cards.slice();
            const range = get.select(event.selectCard);
            const countOK = cards.length >= range[0] && (range[1] < 0 || cards.length <= range[1]);
            const chosen = cards[0];
            let legal = !!(countOK && cards.length === 1 && chosen &&
                player.getCards(event.position || "h").includes(chosen));
            if (legal && typeof lib.filter?.cardDiscardable === "function") {
                try { legal = !!lib.filter.cardDiscardable(chosen, player, event); } catch (e) { legal = false; }
            }
            if (legal) {
                try {
                    legal = typeof realFilter === "function"
                        ? !!realFilter.call(event, chosen, player, event)
                        : Z.test(realFilter, chosen, player, event);
                } catch (e) {
                    legal = false;
                }
            }
            if (legal) {
                restore();
                // 已经由庄周本人盲选，而且真实花色吻合；交回本体正常弃置并继续【火攻】伤害。
                ui.click.ok(Z.v307ConfirmButton());
                return;
            }
            if (Z.v274SafeTestMode) {
                // 保留本次盲选窗口及提交检查，允许重选或取消；不弃牌、不造成伤害、不退场。
                Z.v2Notice("TEST INVALID（仅提示，不判负）：闭眼结算【火攻】时提交的弃牌不符合真实规则；可重选或取消。");
                return;
            }

            // 选择本身允许发生，直到提交时才检查真实花色；错误就是闭眼规则违规。
            // 仅在以后明确关闭测试模式时执行正式违规退场。
            restore();
            ui.click.cancel(Z.v307ConfirmButton());
            Promise.resolve().then(() => Z.expel(player, "闭眼结算【火攻】时弃置了与目标展示牌花色不符的牌"));
        };
        event.custom.replace.confirm = confirm;
        return true;
    };

    // v301【贯石斧】：闭眼庄周能摸清自己装备区有几张牌，但不知道栏位、牌名、花色、点数。
    // 发动时手牌、装备都在本体原生的位置上点牌背（v305 起不再另画一排）。
    // 选择期间不按真实规则灰显（与火攻相同），按确定时再用原生过滤检查；选错只提示、可重选，不判负。
    // 去掉原生“AI代选”（它按真实牌值挑牌）。真实弃置、装备失去及贯石斧效果仍由本体结算。
    // v307：替换 confirm 后，本体点按钮时传进来的按钮节点丢了；本体靠 ok(node)/cancel(node) 关掉确定栏。
    // 交回本体时补上当前确定栏里的按钮，让本体自己关掉它，否则旧确定栏会残留，下一个询问（如【天命】）的按钮出不来。
    Z.v307ConfirmButton = () => ui.confirm?.firstElementChild || ui.confirm?.firstChild || undefined;
    Z.v301EquipOrder = player => {
        const cards = player.getCards("e");
        if (!Z.blind(player)) return player._xd_zz_equipOrder = cards.slice();
        const old = player._xd_zz_equipOrder || cards;
        // 旧装备保留相对顺序，新进入的追加；不按装备类型重排。
        return player._xd_zz_equipOrder = old.filter(card => cards.includes(card))
            .concat(cards.filter(card => !old.includes(card)));
    };
    // v303：Z 确认——闭眼时只要是弃自己的牌（弃牌阶段、技能代价、贯石斧等），无论弃几张都由庄周手选，
    // 不再随机。只接手牌/装备区；含判定区等其他区域的询问仍走原有路径。火攻弃牌另有专门处理。
    Z.v301IsGuanshiDiscard = (event, player) => !!(
        Z.v2proto && event && event.name === "chooseToDiscard" && player && player === game.me &&
        Z.local(player) && Z.blind(player) && /^[he]+$/.test(event.position || "h")
    );
    // v305：Z 要求尽量用原生界面——装备区不再另画一排牌背，而是直接用本体自己的装备区来点选。
    // 选择期间只让本人装备区里的牌可点，每张真实装备牌都盖上原生牌背（与手牌同一套遮罩），点击交给原生 ui.click.card。
    Z.v301Guanshi = null; // { event }
    Z.v305EquipPickActive = player => {
        const event = Z.v301Guanshi?.event;
        return !!(event && !event.finished && event.player === player &&
            (event.position || "h").includes("e") && Z.blind(player));
    };
    Z.v305SyncEquipPickClass = () => {
        if (typeof document === "undefined") return;
        document.documentElement.classList.toggle("xd-zz-v305-equip-pick", Z.v305EquipPickActive(game.me));
    };
    Z.v301TeardownGuanshi = () => {
        const state = Z.v301Guanshi;
        if (!state) return;
        Z.v301Guanshi = null;
        // 先恢复装备区的隐藏，再撤掉装备牌上的牌背，避免露出一帧真实装备。
        Z.v305SyncEquipPickClass();
        try { Z.v27SyncNativeHandMask?.(game.me); } catch (e) {}
    };
    Z.v301RenderGuanshi = event => {
        const state = Z.v301Guanshi;
        if (!state || state.event !== event) return;
        // 先盖牌背，再放开装备区的点击。
        Z.v27SyncNativeHandMask?.(event.player);
        Z.v305SyncEquipPickClass();
    };
    Z.v301PrepareGuanshi = (event, player) => {
        if (!Z.v301IsGuanshiDiscard(event, player)) return false;
        if (event._xd_zz_v301Guanshi) return true;
        event.custom ||= {};
        event.custom.replace ||= {};
        if (typeof event.custom.replace.confirm === "function") return false;

        const realFilter = event.filterCard;
        event._xd_zz_v301Guanshi = true;
        // 本体还会再叠加 cardDiscardable；其余合法性等确定时检查，不提前灰显泄漏哪张是贯石斧。
        event.filterCard = () => true;

        const restore = () => {
            event.filterCard = realFilter;
            if (event.custom?.replace?.confirm === confirm) delete event.custom.replace.confirm;
            if (Z.v301Guanshi?.event === event) Z.v301TeardownGuanshi();
        };
        const confirm = function (ok) {
            if (get.event?.() !== event) return;
            if (!ok) {
                restore();
                ui.click.cancel(Z.v307ConfirmButton());
                return;
            }
            const cards = ui.selected.cards.slice();
            const range = get.select(event.selectCard);
            const source = player.getCards(event.position || "h");
            let legal = cards.length >= range[0] && (range[1] < 0 || cards.length <= range[1]) &&
                new Set(cards).size === cards.length && cards.every(card => source.includes(card));
            if (legal && typeof lib.filter?.cardDiscardable === "function") {
                legal = cards.every(card => {
                    try { return !!lib.filter.cardDiscardable(card, player, event); } catch (e) { return false; }
                });
            }
            if (legal) {
                // 贯石斧的过滤依赖“其他已选牌”（至少留一张贯石斧），逐张按其余已选牌检查。
                legal = cards.every(card => {
                    try {
                        return Z.withSelection({ cards: cards.filter(other => other !== card) }, () =>
                            typeof realFilter === "function"
                                ? !!realFilter.call(event, card, player, event)
                                : Z.test(realFilter, card, player, event));
                    } catch (e) { return false; }
                });
            }
            if (legal && typeof event.filterOk === "function") {
                try { legal = Z.withSelection({ cards }, () => !!event.filterOk()); } catch (e) { legal = false; }
            }
            if (legal) {
                restore();
                ui.click.ok(Z.v307ConfirmButton());
                return;
            }
            // v304：张数是公开信息，只按张数不对时提示重选，不算违规。
            const countWrong = !(cards.length >= range[0] && (range[1] < 0 || cards.length <= range[1]));
            if (countWrong || Z.v274SafeTestMode) {
                Z.v2Notice(countWrong ? "闭眼弃牌：张数不对，请重选。" :
                    "TEST INVALID（正式版将判负）：闭眼弃牌选中了不符合要求的牌；请重选" + (event.forced ? "。" : "或取消。"));
                return;
            }
            // 摸到的牌本身不合规（如弃掉唯一的贯石斧）：与火攻、闭眼出牌一致，属于闭眼违规，判负离场。
            restore();
            ui.click.cancel(Z.v307ConfirmButton());
            Promise.resolve().then(() => Z.expel(player, "闭眼弃牌时选中了不符合要求的牌"));
        };
        event.custom.replace.confirm = confirm;
        return true;
    };
    lib.hooks.checkBegin.push(event => {
        if (Z.v294NativeValidation?.event === event) return;
        const state = Z.v301Guanshi;
        if (state && (state.event !== event || state.event.finished || !Z.blind(game.me))) Z.v301TeardownGuanshi();
    });
    lib.hooks.checkEnd.push(event => {
        if (Z.v294NativeValidation?.event === event) return;
        if (!event?._xd_zz_v301Guanshi || get.event?.() !== event ||
            event.custom?.replace?.confirm == null || !Z.blind(event.player)) return;
        // 本体在首次 game.check 之后才创建“AI代选”；推迟到本步骤结束再关掉，之后每次检查也再确认一次。
        const closeAiPick = () => {
            if (typeof event.promptdiscard?.close === "function") {
                try { event.promptdiscard.close(); } catch (e) {}
                event.promptdiscard = null;
            }
        };
        closeAiPick();
        Promise.resolve().then(closeAiPick);
        if (!Z.v301Guanshi) Z.v301Guanshi = { event };
        Z.v301RenderGuanshi(event);
    });

    // v308【木牛流马】：闭眼放牌后“是否移动木牛流马？”保留原询问，由庄周本人点座位决定，不再随机代选。
    // 点座位走本体 ui.click.target → custom.replace.target，只记录意图；不显示本体“可选”高亮（会暴露谁已阵亡）。
    // 不选就按取消。确定时用本体 filterTarget 检查：点到自己不算；选了不能接收的角色（如已阵亡）按闭眼违规处理。
    Z.v308MuniuMove = null; // { event, target }
    Z.v308IsMuniuMove = event => !!(
        Z.v2proto && event?.name === "chooseTarget" && event.muniu && event.player === game.me &&
        Z.local(event.player) && Z.blind(event.player)
    );
    Z.v308SetMuniuIntent = target => {
        const state = Z.v308MuniuMove;
        if (!state) return;
        for (const current of [...game.players, ...(game.dead || [])]) {
            if (current !== target) current.classList?.remove("xd-zz-v2-proto-selected");
        }
        state.target = target || null;
        target?.classList?.add("xd-zz-v2-proto-selected");
    };
    Z.v308TeardownMuniu = () => {
        const state = Z.v308MuniuMove;
        if (!state) return;
        Z.v308SetMuniuIntent(null);
        const replace = state.event.custom?.replace;
        if (replace?.target === state.onTarget) delete replace.target;
        if (replace?.confirm === state.onConfirm) delete replace.confirm;
        Z.v308MuniuMove = null;
    };
    Z.v308PrepareMuniu = event => {
        if (Z.v308MuniuMove?.event === event) return;
        Z.v308TeardownMuniu();
        const player = event.player;
        event.custom ||= {};
        event.custom.replace ||= {};
        const state = { event, target: null };
        state.onTarget = target => {
            if (get.event?.() !== event || !target || target === player) return;
            Z.v308SetMuniuIntent(state.target === target ? null : target);
            game.check();
        };
        state.onConfirm = ok => {
            if (get.event?.() !== event) return;
            if (!ok) {
                Z.v308TeardownMuniu();
                ui.click.cancel(Z.v307ConfirmButton());
                return;
            }
            const target = state.target;
            if (!target) return;
            let legal = game.players.includes(target) && !game.dead?.includes(target);
            if (legal) {
                try {
                    legal = Z.withSelection({ cards: [], targets: [] }, () =>
                        typeof event.filterTarget === "function"
                            ? !!event.filterTarget(undefined, player, target)
                            : Z.test(event.filterTarget, undefined, player, target));
                } catch (e) { legal = false; }
            }
            if (legal) {
                Z.v308TeardownMuniu();
                Z.v2ReplaceArray(ui.selected.targets, [target]);
                ui.click.ok(Z.v307ConfirmButton());
                return;
            }
            if (Z.v274SafeTestMode) {
                Z.v2Notice("TEST INVALID（正式版将判负）：木牛流马不能移给这名角色；请重选或取消。");
                return;
            }
            Z.v308TeardownMuniu();
            ui.click.cancel(Z.v307ConfirmButton());
            Promise.resolve().then(() => Z.expel(player, "闭眼移动木牛流马时选了不能接收的角色"));
        };
        event.custom.replace.target = state.onTarget;
        event.custom.replace.confirm = state.onConfirm;
        Z.v308MuniuMove = state;
    };
    lib.hooks.checkBegin.push(event => {
        if (Z.v294NativeValidation?.event === event) return;
        const state = Z.v308MuniuMove;
        if (state && (state.event !== event || state.event.finished || !Z.blind(game.me))) Z.v308TeardownMuniu();
        if (Z.v308IsMuniuMove(event) && get.event?.() === event) Z.v308PrepareMuniu(event);
    });
    lib.hooks.checkEnd.push(event => {
        const state = Z.v308MuniuMove;
        if (!state || state.event !== event || get.event?.() !== event) return;
        // 本体的“可选”高亮只落在活着且能接收的角色上，闭眼时一律清掉；选中状态只看庄周自己的意图。
        Z.v2ReplaceArray(ui.selected.targets, []);
        for (const current of [...game.players, ...(game.dead || [])]) {
            current.classList?.remove("selectable", "selected");
        }
        Z.v308SetMuniuIntent(state.target);
        ui.create.confirm(state.target ? "oc" : "c");
    });

    Z.v280AutoPickEligible = (player, event, kind) => {
        if (!Z.v2proto || !event || !Z.local(player) || !Z.blind(player)) return false;
        if (Z.v280IsGuanshiChoice(event, kind)) return false;
        // v308：木牛流马的“是否移动”由庄周本人决定。
        if (kind === "chooseTarget" && event.muniu) return false;
        if (kind !== "chooseButton") return true;
        let dialog = event.dialog;
        if (typeof dialog === "number" && typeof get.idDialog === "function") {
            dialog = get.idDialog(dialog);
        }
        const buttons = dialog?.buttons;
        if (buttons && buttons.length) {
            return Array.from(buttons).every(button => get.itemtype(button?.link) === "card");
        }
        // 五谷丰登有的版本直到事件执行时才建造共用牌池；不因未建造的窗口回退手选。
        try {
            const parent = event.getParent?.();
            return !!(parent?.card && get.name(parent.card) === "wugu");
        } catch (e) { return false; }
    };
    Z.v280InstallAutoPick = (event, player, kind) => {
        if (!event || typeof event.isMine !== "function") return;
        const originalIsMine = event.isMine;
        event.isMine = function (...args) {
            if (!Z.v280AutoPickEligible(player, this, kind)) {
                return originalIsMine.apply(this, args);
            }
            if (!this._xd_zz_v280RandomAI) {
                const scores = new WeakMap();
                // 每个候选本次询问只生成一次随机权重：不读牌面价值，不因 AI 反复调用而抖动。
                this._xd_zz_v280RandomAI = item => {
                    if (!item || (typeof item !== "object" && typeof item !== "function")) {
                        return 0.1 + Math.random();
                    }
                    if (!scores.has(item)) scores.set(item, 0.1 + Math.random());
                    return scores.get(item);
                };
            }
            // 延迟覆盖，避免调用方在 chooseXXX(...).set('ai', ...) 时重新写入非随机权重。
            this.ai = this._xd_zz_v280RandomAI;
            return false; // 由无名杀本体的 AI 分支立即合法选择，不创建本地选牌交互。
        };
    };

    // V2.8.4：无名杀本体的【火攻】通过 showCards() 把目标牌留在中央窗口，随后再询问使用者弃牌。
    // 利用本体 showCards 自带的 hiddencards，只对闭眼庄周所在本机把这张展示牌做成空白；
    // cards2 / filterDiscard 仍保留真实牌与真实花色，所以结算本身完全不变。
    if (typeof PP.showCards === "function") {
        const nativeShowCardsV284 = PP.showCards;
        PP.showCards = function (...args) {
            const next = nativeShowCardsV284.apply(this, args);
            const blindLocal = Z.v2proto && game.me && Z.local(game.me) && Z.blind(game.me) && !Z.ended;
            if (blindLocal && next && Z.v284IsDirectHuogongChild?.(next)) {
                const cards = Array.isArray(next.cards) ? next.cards.slice() : [];
                if (cards.length) {
                    next.hiddencards = cards;
                    // 原文含真实目标姓名；闭眼时一并换成无身份信息的公共描述。
                    next.str = "【火攻】目标展示了一张牌（牌面不可见）";
                    next._xd_zz_v284HuogongHiddenReveal = true;
                }
            }
            return next;
        };
    }

    // v281：闭眼时屏蔽“拿到哪张牌”的原生额外展示，不拦截任何真实获得或公共结算。
    // 不改 v280 随机选牌，不创建新的每帧循环或全局游戏事件监听。
    Z.v281MuteGainFeedback = () => !!(
        Z.v2proto && !Z.ended && Z.local(game.me) && Z.blind(game.me)
    );
    Z.v298MuteDeathFeedback = player => !!(player && player !== game.me && Z.v281MuteGainFeedback());
    // $die/$dieflip 是显示方法；die/dieAfter 等真实死亡结算和技能始终交给本体。
    if (typeof PP.$dieflip === "function") {
        const nativeDieFlip = PP.$dieflip;
        PP.$dieflip = function (...args) {
            if (Z.v298MuteDeathFeedback(this)) return;
            return nativeDieFlip.apply(this, args);
        };
    }
    if (typeof PP.$die === "function") {
        const nativeDie = PP.$die;
        PP.$die = function (...args) {
            if (!Z.v298MuteDeathFeedback(this)) return nativeDie.apply(this, args);
            // 原生已经把角色移入 game.dead；在动画/异步死亡结算之前接管其本地显示。
            if (Z.v215ImageryActive) Z.v282EnsureDeadDreamShell(this);
            const after = Object.getOwnPropertyDescriptor(this, "$dieAfter");
            const hasEffect = typeof this.$dieAfter === "function";
            if (hasEffect && after && !after.configurable && !after.writable) {
                // 不可临时替换的主题特效：保留 v1.11.5.2 的录像/广播，省略本机动画分支。
                game.addVideo("die", this);
                game.broadcast(function (player) { player.$die(); }, this);
                return;
            }
            if (hasEffect) Object.defineProperty(this, "$dieAfter", {
                configurable: after?.configurable ?? true, enumerable: after?.enumerable ?? false,
                writable: true, value() {},
            });
            try {
                // 仍执行原生方法，保留录像与广播；只跳过本机的翻转和 $dieAfter 特效。
                return nativeDie.apply(this, args);
            } finally {
                if (hasEffect) {
                    if (after) Object.defineProperty(this, "$dieAfter", after);
                    else delete this.$dieAfter;
                }
            }
        };
    }
    Z.v297SelfEquipUse = (event, player) => {
        if (event?.name !== "useCard" || event.player !== player || !event.card) return false;
        try { if (get.type(event.card, player) !== "equip") return false; }
        catch (e) { return false; }
        return !(event.targets?.length) || event.targets.every(target => target === player);
    };
    Z.v297SilentCardReason = (player, event) => {
        if (!Z.v281MuteGainFeedback() || !player || player === game.me || !event) return "";
        if (Z.v297SelfEquipUse(event, player)) return "equip";
        // equip 内替换旧装备的动画也无需口述；真实装备区另由 CSS 遮蔽。
        if (event.name === "equip" && event.player === player) return "equip";
        let current = event;
        const seen = new Set();
        for (let depth = 0; current && depth < 8 && !seen.has(current); depth++) {
            seen.add(current);
            // 只跟随原生弃牌的直接链，不能把火攻过程中其他技能用牌/弃牌一并盖掉。
            if (!["lose", "discard", "loseToDiscardpile", "chooseToDiscard"].includes(current.name) ||
                (current.player && current.player !== player)) return "";
            let parent;
            try { parent = current.getParent?.(); } catch (e) { return ""; }
            if (!parent || parent === current) return "";
            if (current.name === "chooseToDiscard") {
                return Z.v284IsHuogongEvent(parent) && parent.player === player ? "huogong-cost" : "";
            }
            current = parent;
        }
        return "";
    };
    Z.v297MaskSilentClone = node => {
        // 这里只接收 $throw 的显示副本，绝不给手牌/装备实体添加 infohidden 或改牌属性。
        node?.classList?.add?.("xd-zz-v297-unspoken-card");
    };
    // 判定高亮会在改判时撤掉。副本单独记住其判定用途，闭眼时连同内部牌名一起遮蔽。
    Z.v299JudgeEvent = event => {
        const pending = [event], seen = new Set();
        while (pending.length && seen.size < 32) {
            const current = pending.shift();
            if (!current || seen.has(current)) continue;
            seen.add(current);
            if (current.name === "judge") return current;
            for (const method of ["getParent", "getTrigger"]) {
                try {
                    const next = current[method]?.();
                    if (next && next !== current && !seen.has(next)) pending.push(next);
                } catch (e) {}
            }
        }
        return null;
    };
    Z.v299IsJudgeDisplay = (card, event) => {
        // 睁眼时也可以标记副本，以便本次判定途中闭眼；CSS 只在闭眼本机生效。
        if (!Z.v2proto || Z.ended || !Z.local(game.me) || !card || !event) return false;
        if (event.name === "judge") return !!event.player?.judging?.includes(card);
        // 原生鬼才等改判通过 highlighted respond 展示替换牌，不遮蔽其他普通响应/用牌。
        return event.name === "respond" && event.highlight === true &&
            !!event.cards?.includes(card) && !!Z.v299JudgeEvent(event);
    };
    // v309 白名单（Z 定的规则）：庄周闭眼时，只有其他角色使用或打出的牌显示牌名（花色点数照旧由 CSS 遮住），
    // 其他一切牌面都不显示。本体几乎所有牌面展示（飞出的牌、弃牌、获得、展示、拼点、对话框里的牌、弃牌堆浏览……）
    // 都来自 Card.prototype.copy 生成的副本，所以闭眼期间每个副本一律先盖本体原生牌背（infohidden/infoflip），
    // 只有“其他角色使用/打出的那张实体牌”在 $throwordered 时揭开。只改显示副本，不动实体牌和结算。
    Z.v309Blind = () => !!(Z.v2proto && !Z.ended && game.me && Z.local(game.me) && Z.blind(game.me) && Z.alive(game.me));
    Z.v309Veil = node => {
        if (!node?.classList || node._xd_zz_v309) return;
        // 副本会继承实体手牌的遮罩透明度；副本本身要露出牌背。
        node.classList.remove("xd-zz-native-under-mask");
        const added = ["infohidden", "infoflip"].filter(name => !node.classList.contains(name));
        node.classList.add(...added, "xd-zz-v309-veiled");
        node._xd_zz_v309 = { added, nointro: node._nointro, bg: node.style?.backgroundImage || "" };
        // 牌面悬停介绍会写出牌名、花色、点数。
        node._nointro = true;
        // 卡牌皮肤可能把牌面图写在内联样式里，会盖过主题的牌背。
        if (node.style?.backgroundImage) node.style.backgroundImage = "";
        Z.v309EnsureObserver();
    };
    Z.v309Unveil = (node, keepNoIntro) => {
        const record = node?._xd_zz_v309;
        if (!record) return;
        delete node._xd_zz_v309;
        node.classList.remove("xd-zz-v309-veiled", ...record.added);
        if (!keepNoIntro) {
            if (record.nointro === undefined) delete node._nointro;
            else node._nointro = record.nointro;
        }
        if (record.bg && !node.style.backgroundImage) node.style.backgroundImage = record.bg;
    };
    // 拼点翻牌、转化牌重绘等会在之后去掉 infohidden；被盖住的副本一旦掉了牌背就立刻补回。
    Z.v309Observer = null;
    Z.v309EnsureObserver = () => {
        if (Z.v309Observer || typeof MutationObserver === "undefined" || typeof document === "undefined") return;
        Z.v309Observer = new MutationObserver(records => {
            for (const record of records) {
                const node = record.target;
                if (node?._xd_zz_v309 && !node.classList.contains("infohidden")) node.classList.add("infohidden");
            }
        });
        Z.v309Observer.observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ["class"] });
    };
    // 睁眼：飞出的牌、弃牌这些闭眼时没看到的副本继续保持背面；
    // 仍留在角色身上的副本（如以牌为标记）是公开信息，睁眼后恢复。
    Z.v309BlindShown = false;
    Z.v309SyncBlindState = blind => {
        if (!blind) {
            try { Z.v309Observer?.disconnect(); } catch (e) {}
            Z.v309Observer = null;
        }
        if (Z.v309BlindShown === !!blind) return;
        Z.v309BlindShown = !!blind;
        if (blind || typeof document === "undefined") return;
        // 仍开着的对话框（如睁眼时轮到自己选的五谷丰登）也是此刻的公开画面，一并恢复。
        for (const node of document.querySelectorAll(".xd-zz-v309-veiled")) {
            if ((node.closest?.(".player") || node.closest?.(".dialog")) && !node.closest(".thrown")) Z.v309Unveil(node);
        }
    };
    // 白名单：本次 $throwordered 抛出的副本，正是其他角色这次使用/打出的实体牌之一。
    Z.v309IsHeardEvent = event => !!(
        event && ["useCard", "respond"].includes(event.name) && event.player && event.player !== game.me &&
        // 改判（高亮打出）会泄露判定，沿用 v299 的判定遮蔽；别人给自己穿装备沿用 v297“未口述”。
        !event.highlight && !Z.v297SelfEquipUse?.(event, event.player)
    );
    // 转化牌（如武圣把桃当杀）：被口述的是“杀”，底下的实体牌不公开。判定与本体 equip/addJudge 用同一标准。
    Z.v309Converted = event => {
        const cards = event?.cards || [];
        return !event?.card || cards.length !== 1 || cards[0]?.name !== event.card.name || !event.card.isCard;
    };
    // 把一张飞出的实体牌副本改画成声明的牌（同本体 makeViewAsCard 的做法：副本是普通 div，借 Card 原型重新 init）。
    Z.v310Declare = (node, vcard) => {
        Z.v309Unveil(node, true);
        const name = get.name?.(vcard, false) || vcard?.name;
        if (name) {
            // 底牌若是整张图的皮肤，牌面图写在副本自身的内联背景上，先清掉，交给 init 按声明的牌重画。
            if (node.style) node.style.backgroundImage = "";
            const Card = lib.element?.Card;
            const proto = Reflect.getPrototypeOf(node);
            try {
                if (Card?.prototype && node.node) {
                    Reflect.setPrototypeOf(node, Card.prototype);
                    node.node.name2 = {};
                    node.node.range = {};
                    node.init(["", "", name, get.nature?.(vcard, false) || vcard?.nature]);
                }
            } catch (error) {
                console.warn("[风雨如晦] v310 声明牌重绘失败", error);
            } finally {
                if (node.node) { delete node.node.name2; delete node.node.range; }
                Reflect.setPrototypeOf(node, proto);
            }
            node.name = name;
        }
        node.suit = "";
        node.number = 0;
        node.classList.add("xd-zz-v309-heard", "xd-zz-v310-declared");
    };
    Z.v309MaybeUnveilHeard = (owner, node) => {
        if (!node?._xd_zz_v309) return;
        const event = get.event?.();
        if (!Z.v309IsHeardEvent(event) || Z.v297SilentCardReason(owner, event)) return;
        const cards = event.cards || [];
        const id = node._cardid;
        const physical = id != null && cards.some(card => card?.cardid === id);
        // 没有实体牌的“视为使用/打出”：本体（开启卡牌动画信息时）临时造一张同名牌抛出。
        const virtual = !cards.length && owner === event.player && !!event.card && node.name === event.card.name;
        // v310：转化牌只“听见”声明的牌名。最后一张实体牌副本改画成无花色点数的声明牌，其余实体副本整张不出现，
        // 既看不出底牌是什么，也看不出用了几张、是否转化。
        if (physical && Z.v309Converted(event)) {
            if (cards[cards.length - 1]?.cardid === id) Z.v310Declare(node, event.card);
            else node.classList.add("xd-zz-v310-folded");
            return;
        }
        if (virtual || physical) {
            // 留着 _nointro：悬停介绍会显示花色点数。
            Z.v309Unveil(node, true);
            node.classList.add("xd-zz-v309-heard");
        }
    };
    // 庄周自己盲用/盲打：本体会在他头像上弹出牌名并念出牌名，闭眼时都不出。
    if (typeof PP.tryCardAnimate === "function") {
        const nativeTryCardAnimate = PP.tryCardAnimate;
        PP.tryCardAnimate = function (...args) {
            const event = get.event?.();
            if (Z.v309Blind() && event && ["useCard", "respond"].includes(event.name) && event.player === this &&
                !Z.v309IsHeardEvent(event)) return;
            return nativeTryCardAnimate.apply(this, args);
        };
    }
    if (typeof game.playCardAudio === "function") {
        const nativePlayCardAudio = game.playCardAudio;
        game.playCardAudio = function (card, sex, ...rest) {
            if (sex === game.me && Z.v309Blind()) return;
            return nativePlayCardAudio.call(this, card, sex, ...rest);
        };
    }
    // 出牌记录栏：闭眼期间新增的记录一律盖牌背、不弹介绍（睁眼后可翻看，与战报同理）。
    if (typeof game.logv === "function") {
        const nativeLogv = game.logv;
        game.logv = function (...args) {
            const node = nativeLogv.apply(this, args);
            if (node?.querySelectorAll && Z.v309Blind()) {
                node._nointro = true;
                for (const card of node.querySelectorAll(".card")) Z.v309Veil(card);
            }
            return node;
        };
    }
    // 对话框里的牌按钮：本体在复制之后又把内联牌面图贴回去；以实体牌造的 vcard 按钮不经过复制。
    const presets = ui.create?.buttonPresets;
    if (presets && typeof presets.card === "function") {
        const nativeCardPreset = presets.card;
        presets.card = function (...args) {
            const node = nativeCardPreset.apply(this, args);
            const record = node?._xd_zz_v309;
            if (record && node.style?.backgroundImage) {
                record.bg = node.style.backgroundImage;
                node.style.backgroundImage = "";
            }
            return node;
        };
    }
    if (presets && typeof presets.vcard === "function") {
        const nativeVcardPreset = presets.vcard;
        presets.vcard = function (item, ...rest) {
            const node = nativeVcardPreset.call(this, item, ...rest);
            if (node && get.itemtype(item) === "card" && Z.v309Blind()) Z.v309Veil(node);
            return node;
        };
    }
    // 右键/长按/悬停庄周自己的头像会列出装备与判定区的牌：闭眼时这些牌换成牌背。
    if (typeof get.nodeintro === "function") {
        const nativeNodeIntro = get.nodeintro;
        get.nodeintro = function (node, ...rest) {
            const uiintro = nativeNodeIntro.call(this, node, ...rest);
            if (uiintro?.querySelectorAll && node === game.me && Z.v309Blind()) {
                for (const card of uiintro.querySelectorAll(".card")) {
                    card.classList.add("infohidden", "infoflip");
                    if (card.style) card.style.backgroundImage = "";
                }
            }
            return uiintro;
        };
    }
    const CP = lib.element.Card?.prototype || lib.element.card;
    if (typeof CP?.copy === "function") {
        const nativeCopy = CP.copy;
        CP.copy = function (...args) {
            const judge = Z.v299IsJudgeDisplay(this, get.event?.());
            const clone = nativeCopy.apply(this, args);
            // 只改返回的动画/展示副本，不标记实体牌，也不修改判定属性与结果。
            if (judge && clone && clone !== this) clone.classList?.add?.("xd-zz-v299-judge-card");
            if (clone && clone !== this && Z.v309Blind()) Z.v309Veil(clone);
            return clone;
        };
    }
    if (typeof PP.popup === "function") {
        const nativePopup = PP.popup;
        PP.popup = function (name, ...args) {
            // 本体的判定结果浮字也是视觉信息；真实判定结果、广播与技能宣告均不改。
            if (this !== game.me && Z.v281MuteGainFeedback() &&
                (name === "判定生效" || name === "判定失效") && get.event?.()?.name === "judge") return;
            return nativePopup.call(this, name, ...args);
        };
    }
    for (const method of ["$throwordered", "$throwordered1", "$throwordered2"]) {
        const native = PP[method];
        if (typeof native !== "function") continue;
        PP[method] = function (node, ...rest) {
            if (Z.v297SilentCardReason(this, get.event?.())) Z.v297MaskSilentClone(node);
            Z.v309MaybeUnveilHeard(this, node);
            return native.call(this, node, ...rest);
        };
    }
    if (typeof PP.$throw === "function") {
        const nativeThrow = PP.$throw;
        PP.$throw = function (cards, ...rest) {
            const reason = Z.v297SilentCardReason(this, get.event?.());
            const result = nativeThrow.call(this, cards, ...rest);
            if (reason) {
                Z.v297MaskSilentClone(result);
                for (const card of Array.isArray(cards) ? cards : [cards]) Z.v297MaskSilentClone(card?.clone);
            }
            return result;
        };
    }
    // v306：Z 定的规则——闭眼庄周弃置的牌（弃自己的或弃别人的）没有人口述，背面朝上进弃牌堆。
    // 用本体自带的“非公开弃置”：把这次 lose 的 visible 去掉，本体自己会给弃牌副本加牌背；战报只记张数。
    Z.v306FaceDownDiscard = event => {
        if (!Z.v2proto || Z.ended || event?.name !== "discard") return false;
        const discarder = event.discarder || event.player;
        return !!(discarder && Z.blind(discarder));
    };
    if (typeof PP.lose === "function") {
        const nativeLose = PP.lose;
        PP.lose = function (...args) {
            const parent = get.event?.();
            const next = nativeLose.apply(this, args);
            if (next && parent?.player === this && Z.v306FaceDownDiscard(parent)) next.visible = false;
            return next;
        };
    }
    // v309：战报在闭眼时虽被收起，但睁眼后（以及暂停页的完整战报）仍能翻看，所以闭眼期间写入的战报同样按白名单处理：
    // 其他角色使用/打出的牌只写牌名；其余实体牌（含庄周自己用的牌）只写张数。
    Z.v309SanitizeLog = (args, event) => {
        const heard = Z.v309IsHeardEvent(event);
        const converted = heard && Z.v309Converted(event);
        // v310：转化/视为的用牌只写声明的牌名，括号里的底牌整段去掉（连“几张牌”也不写，否则仍看得出转化）。
        if (converted && Array.isArray(event?.cards) && event.cards.length) {
            const isCards = value => Array.isArray(value) && value.length && value.every(item => get.itemtype(item) === "card");
            const at = args.findIndex(value => isCards(value) || get.itemtype(value) === "card");
            if (at > 0 && args[at - 1] === "（") {
                if (args[at + 1] === "）") args = args.slice(0, at - 1).concat(args.slice(at + 2));
                else if (typeof args[at + 1] === "string" && args[at + 1].startsWith("，")) {
                    args = args.slice(0, at - 1).concat(["（" + args[at + 1].slice(1)], args.slice(at + 2));
                }
            }
        }
        const own = !!(event && ["useCard", "respond"].includes(event.name) && event.player === game.me);
        const cardName = card => "#y" + String(get.translation(card?.name) || card?.name || "牌");
        return args.map(value => {
            const type = get.itemtype(value);
            let cards = null;
            if (type === "card") cards = [value];
            else if (type === "cards") cards = value;
            else if (Array.isArray(value) && value.length && value.every(item => get.itemtype(item) === "card")) cards = value;
            if (cards) {
                if (!cards.length) return value;
                if (heard && !converted) return cards.length === 1 ? cardName(cards[0]) : cards.map(card => String(get.translation(card.name) || card.name)).join("、");
                return get.cnNumber(cards.length) + "张牌";
            }
            // 转化/虚拟牌对象：本体会连带写出底牌的花色点数。
            if (value && typeof value === "object" && typeof value.name === "string" && lib.card?.[value.name] && !type?.startsWith?.("player")) {
                if (heard) return cardName(value);
                if (own) return "一张牌";
                if (value.suit || value.number) return "一张牌";
            }
            return value;
        });
    };
    if (typeof game.log === "function") {
        const nativeLog = game.log;
        game.log = function (...args) {
            const event = get.event?.();
            if (Z.v309Blind()) {
                // v310：改判（高亮打出，如鬼才、鬼道）只听见“X发动了【技能】”，用哪张牌改的整行不写。
                if (event?.name === "respond" && event.highlight && args[1] === "打出了") return;
                // 用牌后续的“装备了 / 被贴上了”：只有被口述的用牌才写；庄周自己盲用、别人自穿装备不写（动词本身就泄露牌的类别）。
                if (["equip", "addJudge"].includes(event?.name)) {
                    const use = event.getParent?.("useCard");
                    if (use && !Z.v309IsHeardEvent(use)) return;
                    if (use) args = Z.v309SanitizeLog(args, use);
                    else args = Z.v309SanitizeLog(args, event);
                } else args = Z.v309SanitizeLog(args, event);
            } else if (args[1] === "弃置了" && Array.isArray(args[2]) && args[2].length &&
                args[0] === event?.player && Z.v306FaceDownDiscard(event)) {
                args[2] = get.cnNumber(args[2].length) + "张牌";
            }
            return nativeLog.apply(this, args);
        };
    }
    Z.v281InWugu = () => {
        let event = _status.event;
        for (let depth = 0; event && depth < 16; depth++) {
            const card = event.card;
            if (card && (get.name(card, event.player) || card.name) === "wugu") return true;
            const parent = event.getParent?.();
            if (!parent || parent === event) break;
            event = parent;
        }
        return false;
    };

    // 【顺手牵羊】等自动交牌流程会通过 $giveAuto 向本地获牌者展示牌面。
    // 仅遮蔽本地闭眼庄周是接收者时的这段附加动画，player.gain 的实际结算保持原样。
    if (typeof PP.$giveAuto === "function") {
        const nativeGiveAuto = PP.$giveAuto;
        PP.$giveAuto = function (cards, recipient, ...rest) {
            if (recipient === game.me && Z.v281MuteGainFeedback()) return;
            return nativeGiveAuto.apply(this, arguments);
        };
    }

    // 【五谷丰登】的真实 gain 之后，本体另用 $gain2 播放牌面动画；
    // 只跳过闭眼庄周本人以及本次五谷丰登内的该段视觉反馈。
    if (typeof PP.$gain2 === "function") {
        const nativeGain2 = PP.$gain2;
        PP.$gain2 = function (...args) {
            if (Z.v281MuteGainFeedback() && (this === game.me || Z.v281InWugu())) {
                return;
            }
            return nativeGain2.apply(this, args);
        };
    }

    // 五谷牌池的原生共用窗口在其他人选择后也可能写上具体牌名。
    // 只在闭眼本机给窗口加视觉遮蔽：不删除牌池、按钮或窗口，原生自动随机选择仍可读取。
    Z.v281EnsureWuguMaskCSS = () => {
        if (typeof document === "undefined" || document.getElementById("xd-zz-v281-wugu-mask-css")) return;
        const style = document.createElement("style");
        style.id = "xd-zz-v281-wugu-mask-css";
        style.textContent = ".xd-zz-v226-blind .xd-zz-v281-wugu-mask{visibility:hidden!important;pointer-events:none!important;}";
        document.head.appendChild(style);
    };
    // 无懈口述只读原生 info_map 中的牌名与人物引用，不翻译真实角色或整张实体牌。
    // 原生事件、牌面、按钮和无懈连锁均不改；仅替换本地询问的 caption。
    Z.v296WuxieDialogs = new Set();
    Z.v296LocalWuxie = event => !!(Z.v2proto && event?.name === "chooseToUse" &&
        event.type === "wuxie" && event.player === game.me && Z.local(event.player) && event.isMine?.());
    Z.v296DreamWuxiePrompt = event => {
        const fallback = "是否使用【无懈可击】？";
        try {
            let map = event.info_map;
            if (!map) map = event.getParent?.("_wuxie")?._info_map;
            if (!map && event.respondTo?.[1]) map = {
                player: event.respondTo[0], card: event.respondTo[1],
                target: event.source, targets: event.source2, state: event.state,
            };
            if (!map?.card) return fallback;
            const origin = map._source || map;
            const cardName = card => {
                const name = typeof card?.viewAs === "string" ? card.viewAs : card?.name;
                return name ? String(get.translation(name) || name) : "";
            };
            const name = cardName(origin.card);
            const responseName = cardName(map.card) || name;
            if (!name || !responseName) return fallback;
            let declaration = "";
            if (origin.isJudge && origin.target) {
                declaration = Z.v226PlayerName(origin.target) + "的【" + name + "】";
            } else if (origin.player) {
                const targets = origin.multitarget || origin.multitargets ? origin.targets || [] :
                    origin.target ? [origin.target] : [];
                const names = [...new Set(targets.filter(Boolean))].map(target => Z.v226PlayerName(target));
                declaration = Z.v226PlayerName(origin.player) + (names.length ? "对" + names.join("、") : "") +
                    "使用的【" + name + "】";
            }
            if (declaration) declaration += "即将" + ((map.state ?? event.state ?? 1) > 0 ? "生" : "失") + "效。";
            // 连续无懈保留原锦囊的公开语境，同时说清本次响应的是上一张无懈。
            if (map._source && map.player) declaration += Z.v226PlayerName(map.player) +
                "使用了【" + responseName + "】。";
            return Z.v226Escape(declaration + "是否对【" + responseName + "】使用【无懈可击】？");
        } catch (e) { return fallback; }
    };
    Z.v296SyncWuxieDialogs = (forceOpen = false) => {
        for (const record of Z.v296WuxieDialogs) {
            const { event, dialog, caption, original } = record;
            const blind = !forceOpen && !Z.ended && !event.finished &&
                Z.v296LocalWuxie(event) && Z.blind(event.player);
            const text = blind ? Z.v296DreamWuxiePrompt(event) : original;
            if (record.text === text) continue;
            if (caption) caption.innerHTML = text;
            else if (typeof dialog.setCaption === "function") dialog.setCaption(text);
            record.text = text;
        }
    };
    if (typeof ui?.create?.dialog === "function") {
        const nativeCreateDialog = ui.create.dialog;
        ui.create.dialog = function (...args) {
            const event = get.event?.();
            const wuxie = Z.v296LocalWuxie(event) && typeof args[0] === "string" && args[0] === event.prompt;
            const original = args[0];
            if (wuxie && !Z.ended && Z.blind(event.player)) args[0] = Z.v296DreamWuxiePrompt(event);
            const dialog = nativeCreateDialog.apply(this, args);
            if (event?.name === "judge" && Z.v2proto && !Z.ended && Z.local(game.me) &&
                args[0] === `${get.translation(event.player)}的${event.judgestr}判定`) {
                // 本体的判定展示窗无选择按钮；隐藏本机显示，不改变窗口或录像的生命周期。
                dialog?.classList?.add?.("xd-zz-v299-judge-dialog");
            }
            if (wuxie && dialog) {
                const record = { event, dialog, original, text: args[0], caption: dialog.querySelector?.(".caption") };
                Z.v296WuxieDialogs.add(record);
                if (typeof dialog.close === "function") {
                    const close = dialog.close;
                    dialog.close = function (...closeArgs) {
                        Z.v296WuxieDialogs.delete(record);
                        return close.apply(this, closeArgs);
                    };
                }
            }
            if (args[0] === "五谷丰登" && Z.v281MuteGainFeedback() && dialog?.classList) {
                Z.v281EnsureWuguMaskCSS();
                dialog.classList.add("xd-zz-v281-wugu-mask");
            }
            return dialog;
        };
    }
    lib.hooks.checkBegin.push(event => {
        if (Z.v294NativeValidation?.event === event) return;
        Z.v296SyncWuxieDialogs();
    });

    // V2.7 默认走原生 chooseToUse / chooseToRespond；下方旧 request 分支仅作历史兼容，不应在 v2proto=true 时启用。
    for (const name of ["chooseToUse", "chooseToRespond"]) {
        const original = PP[name];
        Z.raw[name] = original;
        PP[name] = function (...args) {
            const next = original.apply(this, args);
            if (!Z.v2proto && Z.local(this)) {
                next.setContent(async function (event) {
                    await lib.xd_utils.zhuangzhou.request(event);
                });
            }
            return next;
        };
    }

    // 基础盲选：不预筛候选，提交后判断。
    for (const name of [
        "chooseCard",
        "chooseToDiscard",
        "chooseTarget",
    ]) {
        const original = PP[name];
        if (!original) continue;

        PP[name] = function (...args) {
            const next = original.apply(this, args);
            // 【火攻】弃同花色牌必须由闭眼庄周本人盲选；不能继续走 v280 的随机 AI 代选。
            const huogongManual = Z.v2proto && name === "chooseToDiscard" &&
                Z.v284PrepareHuogongDiscard?.(next, this);
            // v301【贯石斧】：闭眼庄周本人手选，可选匿名装备牌背；不走随机代选。
            const guanshiManual = Z.v2proto && name === "chooseToDiscard" && !huogongManual &&
                Z.v301PrepareGuanshi?.(next, this);
            if (Z.v2proto && Z.local(this) && !huogongManual && !guanshiManual) Z.v280InstallAutoPick(next, this, name);

            if (!Z.v2proto && Z.local(this) && Z.blind(this)) {
                next.setContent(async function (event) {
                    const z = lib.xd_utils.zhuangzhou;
                    const player = event.player;
                    const isTarget =
                        event.name === "chooseTarget";

                    z.rememberSeats();

                    const items = isTarget
                        ? z.seats.slice()
                        : z.blindCards(
                            player,
                            event.position || "h"
                        );

                    const choice = await z.pick(
                        player,
                        isTarget
                            ? "选择目标"
                            : "选择牌的位置",
                        items,
                        (item, index) => isTarget
                            ? "座位 " + (index + 1)
                            : item.label,
                        !event.forced
                    );

                    if (choice === null) {
                        event.result = { bool: false };
                        return;
                    }

                    const chosen = isTarget
                        ? choice
                        : choice.map(item => item.card);

                    if (chosen.some(item => !item)) {
                        await z.expel(
                            player,
                            "选择了空的牌位"
                        );
                        event.result = { bool: false };
                        return;
                    }

                    const specification = isTarget
                        ? event.selectTarget
                        : event.selectCard;

                    const filter = isTarget
                        ? event.filterTarget
                        : event.filterCard;

                    const countOK = z.countOK(
                        chosen,
                        specification
                    );

                    const bad = z.withSelection(
                        isTarget
                            ? { targets: chosen }
                            : { cards: chosen },
                        () => chosen.filter(item =>
                            isTarget
                                ? !z.alive(item) ||
                                    !z.test(
                                        filter,
                                        null,
                                        player,
                                        item
                                    )
                                : !z.test(
                                    filter,
                                    item,
                                    player
                                )
                        )
                    );

                    if (
                        !countOK ||
                        (isTarget && bad.length)
                    ) {
                        await z.expel(
                            player,
                            "盲选提交的数量或目标不合法"
                        );

                        event.result = { bool: false };
                        return;
                    }

                    if (bad.length) {
                        z.defer(
                            player,
                            bad,
                            "此前盲选的牌公开后不符合要求"
                        );
                    }

                    event.result = isTarget
                        ? { bool: true, targets: chosen }
                        : { bool: true, cards: chosen };

                    if (
                        event.name === "chooseToDiscard" &&
                        event.chooseonly !== true
                    ) {
                        await player.discard(chosen);
                    }
                });
            }

            return next;
        };
    }

    // 不使用原 prompt，避免其中夹带当前牌桌或底牌详情。
    for (const name of [
        "chooseBool",
        "chooseControl",
    ]) {
        const original = PP[name];
        if (!original) continue;

        PP[name] = function (...args) {
            const next = original.apply(this, args);

            if (!Z.v2proto && Z.local(this) && Z.blind(this)) {
                next.setContent(async function (event) {
                    const z = lib.xd_utils.zhuangzhou;

                    if (event.name === "chooseBool") {
                        event.result = {
                            bool: await z.yes(
                                "是否执行当前询问的效果？"
                            ),
                        };
                    } else {
                        const controls =
                            event.controls || [];

                        if (!controls.length) {
                            throw new Error(
                                "庄周：chooseControl 没有可识别的 controls"
                            );
                        }

                        const control = await z.choose(
                            "请选择",
                            controls,
                            controls.map(item =>
                                get.translation(item)
                            ),
                            false
                        );

                        event.result = {
                            control,
                            index: controls.indexOf(control),
                        };
                    }
                });
            }

            return next;
        };
    }

    // 选择别人的牌：输入区域及位置，不展示区域数量、是否为空。
    for (const name of [
        "choosePlayerCard",
        "gainPlayerCard",
        "discardPlayerCard",
    ]) {
        const original = PP[name];
        if (!original) continue;

        PP[name] = function (...args) {
            const next = original.apply(this, args);
            if (Z.v2proto && Z.local(this)) Z.v280InstallAutoPick(next, this, name);

            if (!Z.v2proto && Z.local(this) && Z.blind(this)) {
                next.setContent(async function (event) {
                    const z = lib.xd_utils.zhuangzhou;
                    const player = event.player;
                    const target = event.target;

                    if (!target) {
                        throw new Error(
                            "庄周：无法识别此次选牌的目标"
                        );
                    }

                    const position =
                        event.position || "he";

                    const keys = await z.dialog(
                        "凭记忆指定对方牌的位置",
                        ({ row, button, finish }) => {
                            const controls = row();
                            const zone =
                                document.createElement(
                                    "select"
                                );

                            for (
                                const key of
                                ["h", "e", "j"].filter(
                                    item => position.includes(item)
                                )
                            ) {
                                const option =
                                    document.createElement(
                                        "option"
                                    );

                                option.value = key;
                                option.textContent = {
                                    h: "手牌区",
                                    e: "装备区",
                                    j: "判定区",
                                }[key];

                                zone.appendChild(option);
                            }

                            controls.appendChild(zone);

                            const input =
                                document.createElement("input");

                            input.type = "number";
                            input.min = "1";
                            input.value = "1";
                            input.style.cssText =
                                "font:inherit;width:5em;";

                            controls.appendChild(input);

                            const values = [];
                            const list = row();

                            button(
                                controls,
                                "添加位置",
                                () => {
                                    const index =
                                        Number(input.value);

                                    if (
                                        !Number.isInteger(index) ||
                                        index < 1 ||
                                        !zone.value
                                    ) {
                                        return;
                                    }

                                    const key =
                                        zone.value + ":" + index;

                                    if (values.includes(key)) {
                                        return;
                                    }

                                    values.push(key);

                                    const element = button(
                                        list,
                                        key,
                                        () => {
                                            values.splice(
                                                values.indexOf(key),
                                                1
                                            );
                                            element.remove();
                                        }
                                    );
                                }
                            );

                            button(
                                row(),
                                "确认提交",
                                () => finish(values.slice())
                            );

                            if (!event.forced) {
                                button(
                                    row(),
                                    "取消",
                                    () => finish(null)
                                );
                            }
                        }
                    );

                    if (keys === null) {
                        event.result = { bool: false };
                        return;
                    }

                    const cards = keys.map(key => {
                        const [zone, number] = key.split(":");

                        return target.getCards(zone)[
                            Number(number) - 1
                        ];
                    });

                    const buttons = cards.map(card => ({
                        link: card,
                    }));

                    const valid =
                        z.alive(target) &&
                        cards.every(Boolean) &&
                        new Set(cards).size === cards.length &&
                        z.countOK(cards, event.selectButton) &&
                        z.withSelection(
                            { buttons },
                            () => buttons.every(item =>
                                z.test(
                                    event.filterButton,
                                    item,
                                    player
                                )
                            )
                        );

                    if (!valid) {
                        await z.expel(
                            player,
                            "指定了不存在或不合法的取牌位置"
                        );

                        event.result = { bool: false };
                        return;
                    }

                    event.result = {
                        bool: true,
                        links: cards,
                        buttons,
                    };

                    if (event.name === "gainPlayerCard") {
                        await player.gain(
                            cards,
                            target,
                            "giveAuto"
                        );
                    } else if (
                        event.name === "discardPlayerCard"
                    ) {
                        await target.discard(cards);
                    }
                });
            }

            return next;
        };
    }

    // 按钮型窗口只显示位置编号，不显示候选牌面。
    if (PP.chooseButton) {
        const original = PP.chooseButton;

        PP.chooseButton = function (...args) {
            const next = original.apply(this, args);
            if (Z.v2proto && Z.local(this)) Z.v280InstallAutoPick(next, this, "chooseButton");

            if (!Z.v2proto && Z.local(this) && Z.blind(this)) {
                next.setContent(async function (event) {
                    const z = lib.xd_utils.zhuangzhou;
                    const player = event.player;

                    let dialog = event.dialog;
                    let created = false;

                    if (
                        typeof dialog === "number" &&
                        get.idDialog
                    ) {
                        dialog = get.idDialog(dialog);
                    }

                    if (!dialog?.buttons) {
                        const specification =
                            event.createDialog ||
                            (
                                Array.isArray(dialog)
                                    ? dialog
                                    : null
                            );

                        if (!specification) {
                            throw new Error(
                                "庄周：此 chooseButton 的 dialog 结构尚未适配"
                            );
                        }

                        dialog = ui.create.dialog.apply(
                            ui.create,
                            specification
                        );

                        created = true;
                    }

                    try {
                        const buttons = Array.from(
                            dialog.buttons || []
                        );

                        if (!buttons.length) {
                            throw new Error(
                                "庄周：此按钮窗口没有可识别的 buttons"
                            );
                        }

                        const chosen = await z.pick(
                            player,
                            "选择按钮位置",
                            buttons,
                            (_, index) =>
                                "位置 " + (index + 1),
                            !event.forced
                        );

                        if (chosen === null) {
                            event.result = { bool: false };
                            return;
                        }

                        if (
                            !z.countOK(
                                chosen,
                                event.selectButton
                            )
                        ) {
                            await z.expel(
                                player,
                                "按钮选择数量不合法"
                            );

                            event.result = { bool: false };
                            return;
                        }

                        const bad = z.withSelection(
                            { buttons: chosen },
                            () => chosen.filter(item =>
                                !z.test(
                                    event.filterButton,
                                    item,
                                    player
                                )
                            )
                        );

                        const badCards = bad
                            .map(item => item.link)
                            .filter(item =>
                                get.itemtype(item) === "card"
                            );

                        if (badCards.length !== bad.length) {
                            await z.expel(
                                player,
                                "按钮选择不合法"
                            );

                            event.result = { bool: false };
                            return;
                        }

                        z.defer(
                            player,
                            badCards,
                            "此前盲选的按钮牌公开后不符合要求"
                        );

                        event.result = {
                            bool: true,
                            buttons: chosen,
                            links: chosen.map(item => item.link),
                        };
                    } finally {
                        if (created) dialog.close();
                    }
                });
            }

            return next;
        };
    }

    if (PP.chooseCardTarget) {
        const original = PP.chooseCardTarget;

        PP.chooseCardTarget = function (...args) {
            const next = original.apply(this, args);

            if (!Z.v2proto && Z.local(this) && Z.blind(this)) {
                next.setContent(async function (event) {
                    const z = lib.xd_utils.zhuangzhou;
                    const player = event.player;

                    const entries = z.blindCards(
                        player,
                        event.position || "h"
                    );

                    const picked = await z.pick(
                        player,
                        "选择牌的位置",
                        entries,
                        entry => entry.label,
                        !event.forced
                    );

                    if (picked === null) {
                        event.result = { bool: false };
                        return;
                    }

                    const cards = picked.map(
                        item => item.card
                    );

                    if (cards.some(card => !card)) {
                        await z.expel(
                            player,
                            "选择了空的牌位"
                        );

                        event.result = { bool: false };
                        return;
                    }

                    z.rememberSeats();

                    const targets = await z.pick(
                        player,
                        "选择目标座位",
                        z.seats.slice(),
                        (_, index) =>
                            "座位 " + (index + 1),
                        !event.forced
                    );

                    if (targets === null) {
                        event.result = { bool: false };
                        return;
                    }

                    const checked = z.withSelection(
                        { cards, targets },
                        () => ({
                            badCards: cards.filter(card =>
                                !z.test(
                                    event.filterCard,
                                    card,
                                    player
                                )
                            ),
                            targetsOK: targets.every(target =>
                                z.alive(target) &&
                                z.test(
                                    event.filterTarget,
                                    null,
                                    player,
                                    target
                                )
                            ),
                        })
                    );

                    if (
                        !z.countOK(cards, event.selectCard) ||
                        !z.countOK(
                            targets,
                            event.selectTarget
                        ) ||
                        !checked.targetsOK
                    ) {
                        await z.expel(
                            player,
                            "组合选择的数量或目标不合法"
                        );

                        event.result = { bool: false };
                        return;
                    }

                    z.defer(
                        player,
                        checked.badCards,
                        "此前组合盲选的牌公开后不符合要求"
                    );

                    event.result = {
                        bool: true,
                        cards,
                        targets,
                    };
                });
            }

            return next;
        };
    }

    const oldOver = game.over;

    game.over = function (...args) {
        Z.ended = true;
        if (Z.v2proto && Z.v2DestroyAll) Z.v2DestroyAll("game-over");
        Z.v27UnmaskAllNativeCards?.();
        Z.v274CloseTestPeekControl?.();
        Z.v301TeardownGuanshi?.();
        Z.v215StopImagery?.();
        Z.v245RestoreOtherSkillButtons?.();
        Z.v215ManualImagery?.clear();
        Z.v287GrilledArts?.clear();
        Z.v220PersistentForms?.clear();
        Z.v239DuelStates?.clear();
        Z.v215PreviousMap?.clear();
        if (typeof document !== "undefined") {
            document.documentElement.classList.remove("xd-zz-blind");
            document.body.classList.remove("xd-zz-blind");
        }
        if (Z.root) {
            Z.stage.hidden = true;
            Z.modalLayer.replaceChildren();
            if (Z.root.hidePopover && Z.root.matches(":popover-open")) Z.root.hidePopover();
        }

        return oldOver.apply(this, args);
    };

    const skills = {
        xd_mei: {
            zhuanhuanji: true,
            mark: true,
            marktext: "寐",

            intro: {
                content(storage, player) {
                    const state =
                        lib.xd_utils.zhuangzhou.state(player);

                    return (
                        (state.yin ? "阴" : "阳") +
                        "；闭眼：" + state.closed +
                        "；" +
                        (
                            state.lock
                                ? "下次仅可发动【" +
                                    (
                                        state.lock === "dream"
                                            ? "梦"
                                            : "醒"
                                    ) + "】"
                                : "无技能限制"
                        )
                    );
                },
            },

            trigger: {
                player: "loseAfter",
            },

            direct: true,

            filter(event, player) {
                const z = lib.xd_utils.zhuangzhou;
                const state = z.state(player);
                const loss = event._xd_zz_loss;

                if (!loss || state.lock) return false;

                return state.yin
                    ? loss.shown && state.closed > 0
                    : loss.hidden && state.closed < 2;
            },

            async content(event, trigger, player) {
                const z = lib.xd_utils.zhuangzhou;
                const state = z.state(player);

                const prompt = state.yin ? "发动【寐】：睁开一只眼？" : "发动【寐】：闭上一只眼？";
                const agree = z.local(player) && !z.v2proto ? await z.yes(prompt) :
                    (await player.chooseBool(prompt).set("ai", () => state.yin).forResult()).bool;

                if (!agree || state.lock || (state.yin ? state.closed === 0 : state.closed === 2)) return;

                player.logSkill("xd_mei");

                z.eyes(
                    player,
                    state.closed + (state.yin ? -1 : 1)
                );

                state.yin = !state.yin;
                player.storage.xd_mei = state.yin;
                player.markSkill("xd_mei");
            },
        },

        // 【梦】【醒】仍作为原生 chooseToUse 技能入口；双闭眼时由 V2.7 BlindBroker 清除原生合法性高亮。
        xd_meng: {
            mark: true,
            marktext: "梦",
            intro: {
                content: "在用牌询问中选择【梦】",
            },
        },

        xd_xing: {
            mark: true,
            marktext: "醒",
            group: "xd_xing_empty",
            intro: {
                content: "在用牌询问中选择【醒】",
            },
        },

        // 【醒】的“无牌可供明置”分支。
        // 与正常【醒】互斥：只有当前没有任何暗置手牌时才出现。
        // 不选牌、不问确定；点击技能即先睁眼，再按“否则”锁到【梦】。
        xd_xing_empty: {
            sourceSkill: "xd_xing",
            enable: "chooseToUse",
            filter(event, player) {
                if (_status.connectMode || !Z.allowed(player, "awake")) return false;
                if (Z.state(player).closed <= 0) return false;
                return !Z.hasAwakeMaterial(player);
            },
            filterCard() { return false; },
            selectCard: -1,
            discard: false, lose: false, delay: false, log: false,
            async content(event, trigger, player) {
                const frame = Z.begin(player, "awake");
                // 睁眼已经无条件完成；因为没有牌可供明置，后半句无法完成，故执行“否则”。
                Z.fail(frame);
                Z.finish(frame);

                // 【醒】本身不能替代当前原生的“使用一张牌”要求。
                // 若它发生在一个 chooseToUse 询问中，发动后让该询问重新开始；
                // 这样出牌阶段可以继续操作，回合外也仍需正常完成原先的响应。
                let request = event.getParent?.();
                for (let i = 0; request && i < 6 && request.name !== "chooseToUse"; i++) {
                    request = request.getParent?.();
                }
                if (request?.name === "chooseToUse" && typeof request.goto === "function") {
                    if (request.skill === "xd_xing_empty") request.skill = null;
                    request.goto(0); // Continue the original response request, not another 【醒】 activation.
                }
            },
            ai: { order: 7 },
        },

        xd_zz_lock_blocker: {
            charlotte: true,
            skillBlocker(skill, player) {
                const z = lib.xd_utils.zhuangzhou;
                if (!z.state(player).lock || z.v301LockExempt.includes(skill)) return false;
                const info = get.info(skill);
                if (!info || info.charlotte || info.equipSkill) return false;
                return true;
            },
        },

        xd_zhuangzhou_engine: {
            charlotte: true, forced: true, popup: false, forceDie: true,
            firstDo: true, priority: 100000,
            trigger: { global: [
                "gameStart", "enterGame", "loseBefore", "loseAfter", "gainAfter",
                "useCardBefore", "useCard1", "useCardAfter", "respondBefore",
                "cardsDiscardAfter", "showCardsAfter", "addShownCardsAfter", "hideShownCardsAfter",
                "equipAfter", "addJudgeAfter", "dieAfter", "changeSkillsAfter",
                "phaseUseBegin", "phaseUseEnd", "chooseToUseAfter", "useCardToTarget", "damageEnd",
            ] },
            async content(event, trigger) {
                const z = lib.xd_utils.zhuangzhou;
                const name = event.triggername;
                if (name === "gameStart" || name === "enterGame") {
                    z.rememberSeats();
                    z.refresh();
                    return;
                }
                // V2.7.3 测试脚手架：正式技能本身并非“出牌阶段自动闭眼”。
                // 这里只为了让实机回归可以稳定进入 BlindBroker / 原生牌背遮罩环境。
                // 等闭眼出牌核心验证完毕后必须删除这段自动闭眼逻辑，恢复真实【寐】状态机。
                // 仅在总开关 ZHUANGZHOU_TEST_SCAFFOLD 打开时生效。
                if (z.v274SafeTestMode && name === "phaseUseBegin" && z.v2proto && trigger.player === game.me && z.owns(trigger.player)) {
                    if (z.state(trigger.player).closed !== 2) z.eyes(trigger.player, 2);
                    else z.refresh();
                    z.v274RefreshTestPeekControl?.(trigger.player);
                    z.v272StartBackTracking?.();
                }
                if (name === "phaseUseEnd" && z.v2proto && trigger.player === game.me && z.owns(trigger.player)) {
                    z.v2DestroyAll("phase-use-end");
                }
                if (name === "chooseToUseAfter") {
                    const player = trigger.player;
                    const pending = player?._xd_zz_pendingAwake;
                    if (pending?.request === trigger) {
                        if (pending.frame && !pending.frame.finished) {
                            // 已经发动【醒】并睁眼，却没有成功进入“明置并使用牌”链：执行“否则”。
                            z.fail(pending.frame);
                            z.finish(pending.frame);
                        }
                        // 无论成功与否都不能让旧请求污染下一次【醒】入口。
                        delete player._xd_zz_pendingAwake;
                        z.v230RefreshNativeChoice(player);
                    }
                }
                if (name === "loseBefore" && z.owns(trigger.player)) {
                    const player = trigger.player;
                    const hand = player.getCards("h");
                    const cards = (trigger.cards || []).filter(card => hand.includes(card));
                    // 只快照真实离手事件；翻面不会制造 lose 事件。
                    trigger._xd_zz_loss = {
                        shown: cards.some(card => z.shown(card, player)),
                        hidden: cards.some(card => !z.shown(card, player)),
                    };
                }
                if (["cardsDiscardAfter", "showCardsAfter", "addShownCardsAfter", "equipAfter", "addJudgeAfter", "respondBefore"].includes(name)) {
                    await z.checkEvidence(trigger.cards || [], name === "cardsDiscardAfter");
                }
                if (name === "gainAfter") {
                    // 私下转移给别人并不构成向全场公开。
                    for (const record of z.pending.slice()) {
                        if (trigger.player === record.player) continue;
                        record.cards = record.cards.filter(card => !(trigger.cards || []).includes(card));
                        if (!record.cards.length) z.pending.splice(z.pending.indexOf(record), 1);
                    }
                }
                if (name === "useCard1" && z.v226DreamReportActive) z.v226RecordUseCard(trigger);
                if (name === "respondBefore" && z.v226DreamReportActive) z.v309RecordRespond?.(trigger);
                if (name === "useCard1" && z.v215ImageryActive) z.v239BeginUse(trigger);
                if (name === "useCardToTarget" && z.v215ImageryActive && z.local(game.me) && z.blind(game.me)) {
                    // 追加/单独指定的目标也计入；不抢技能的真实目标处理。
                    z.v239RegisterTarget(z.v239GetUseEvent(trigger), trigger.player, trigger.target);
                    const target = trigger.target || trigger.player;
                    const source = trigger.player;
                    if (target && target !== game.me) {
                        // 仅记录已经发生的公开指定；映射切换不改真实用牌链。
                        z.v226RecordTransformation(target, z.v220OnTargeted(source, target, trigger.card));
                        if (source === game.me) z.v241OnZhuangzhouUseOnOthers?.();
                    }
                }
                if (name === "damageEnd") {
                    // 同一次 useCard 子树下真的造成伤害，不能计作削灰而不伤。
                    z.v239RegisterDamage(trigger);
                    // 保留烤鱼等变图，不播报伤害数值；同一事件重复进入只处理一次。
                    z.v230HandleDamageEnd(trigger);
                }
                if (name === "useCardAfter" && z.v215ImageryActive) z.v239FinalizeUse(trigger);
                if (name === "useCardBefore" && trigger.card?.storage?._xd_zz_v230RejectedAwake) {
                    trigger.cancel();
                    return;
                }
                const token = z.tokenOf(trigger);
                if (name === "useCardBefore") {
                    if (token) {
                        z.useTrace(token, "已进入useCardBefore");
                        if (!token.frame) token.frame = z.begin(token.player, token.mode);
                        // V2.7.9：日志证明同一次发动可能多次进入 useCardBefore。
                        // 只在第一次进入时要求「梦选明牌 / 醒选暗牌」并执行翻面。
                        // 第一次翻面已经改变牌的明暗状态；第二次若再用翻面前的条件
                        // 检查同一张牌，会把已成功翻面的正常用牌错误取消。
                        if (token.flipped) {
                            z.useTrace(token, "重复进入useCardBefore：沿用此前明暗置结果；" +
                                (token.firstUseEvent === trigger ? "原事件" : "事件引用不同，保留进一步诊断"));
                        } else {
                            if (!await z.flip(token)) {
                                // 首次尝试期间牌被其他效果移走或原本状态不符，不能伪造成功使用。
                                z.useTrace(token, "首次明暗置检查失败：取消用牌");
                                trigger.cancel();
                                return;
                            }
                            z.useTrace(token, "明暗置完成");
                            if (!token.zoneTransfer) {
                                // 首次成功翻面后才去实体化，保留原生 chooseToUse 的选牌结果。
                                // 后续重复进入 useCardBefore 不再重复更改牌材料。
                                trigger.cards = [];
                                if (Array.isArray(trigger.card?.cards)) trigger.card.cards = [];
                                z.useTrace(token, "已进入使用事件后转为无材料虚拟牌");
                            }
                        }
                    } else {
                        await z.checkEvidence(trigger.cards || [], false);
                    }
                }
                if (name === "useCard1" && token) {
                    token.used = true;
                    z.useTrace(token, "已进入useCard1");
                }
                if (name === "useCardAfter" && token) z.useTrace(token, "已进入useCardAfter");
                z.refresh();
            },
        },
    };

    const translate = {
        xd_zhuangzhou: "庄周",
        visible_xd_zhuangzhou: "明置",

        xd_mei: "寐",
        xd_mei_info:
            "转换技，阳：你失去暗置牌后，可以闭上一只眼；" +
            "阴：你失去明置牌后，可以睁开一只眼。",

        xd_meng: "梦",
        xd_meng_info:
            "你可以以暗置方式使用牌，然后重铸所有与之同花色的明置牌并闭上双眼，" +
            "否则，你下次仅能发动【醒】。",

        xd_xing: "醒",
        xd_xing_empty: "醒",
        xd_xing_info:
            "你可以睁开双眼并以明置方式使用牌，然后重铸所有与之同花色的暗置牌，" +
            "否则，你下次仅能发动【梦】。",
        xd_zz_lock_blocker: "梦醒限制",
        xd_xing_empty_info:
            "你可以睁开双眼并以明置方式使用牌，然后重铸所有与之同花色的暗置牌，" +
            "否则，你下次仅能发动【梦】。",
    };

    // 【梦】继续在闭眼状态下由 BlindBroker 接管；【醒】一经发动先睁眼，再回到原生可见手牌选择。
    // 普通牌使用时实体材料留手；装备/延时锦囊保留实体材料以完成真实区域转移。
    for (const [id, mode] of [["xd_meng", "dream"], ["xd_xing", "awake"]]) {
        Object.assign(skills[id], {
            enable: "chooseToUse", position: "h", selectCard: 1,
            discard: false, lose: false, delay: false, log: false,
            filter(event, player) {
                if (_status.connectMode || !Z.allowed(player, mode)) return false;
                if (mode === "awake") {
                    // 有牌分支：点击【醒】后先睁眼，随后必须选 1 张原先暗置的手牌；
                    // pending frame 用于睁眼后维持同一次【醒】的原生选牌流程。
                    if (Z.v228PendingAwake(player, event)) return true;
                    return Z.state(player).closed > 0 && Z.hasAwakeMaterial(player);
                }
                return player.getCards("h").some(card => Z.shown(card, player));
            },
            filterCard(card, player) {
                if (mode === "awake") {
                    const frame = player._xd_zz_pendingAwake?.frame;
                    if (frame?.material && !frame.finished && card !== frame.material) return false;
                }
                return Z.shown(card, player) === (mode === "dream");
            },
            viewAs(cards, player) {
                if (cards.length !== 1) return null;
                // 让本体自己构造最终 VCard；这里只返回“这张实体牌本来的信息”。
                // 不再在 onuse 阶段把本体已经构造好的 result.card 整体替换掉。
                const fact = Z.fact(cards[0], player);
                const card = {
                    name: fact.name,
                    suit: fact.suit,
                    number: fact.number,
                    isCard: true,
                };
                if (fact.nature) card.nature = fact.nature;
                return card;
            },
            onuse(result, player) {
                const material = result.cards?.[0];
                if (!material || !result.card) return;
                if (mode === "awake" && Z.v2proto) {
                    const pending = player._xd_zz_pendingAwake;
                    const ongoing = pending && !pending.cancelled &&
                        !pending.frame?.finished && Z.allowed(player, "awake");
                    if ((ongoing && pending.frame.material && pending.frame.material !== material) ||
                        (!ongoing && !(Z.allowed(player, "awake") && Z.state(player).closed > 0))) {
                        // No closed eye, and no live first-open selection: do not run Z.begin
                        // again even if native UI submitted a stale “醒” button.
                        result.card.storage ||= {};
                        result.card.storage._xd_zz_v230RejectedAwake = true;
                        return;
                    }
                }
                let frame;
                if (mode === "awake" && player._xd_zz_pendingAwake?.frame &&
                    !player._xd_zz_pendingAwake.cancelled && !player._xd_zz_pendingAwake.frame.finished) {
                    frame = player._xd_zz_pendingAwake.frame;
                    delete player._xd_zz_pendingAwake;
                    Z.v229DisarmCancel(frame); // 已提交真实用牌，后续本体 UI 清理不可再按“取消【醒】”处理。
                } else {
                    frame = Z.begin(player, mode);
                }
                const token = Z.makeToken(player, mode, material, frame);

                // 核心修正：保留本体原生 chooseToUse 已构造好的 card / targets / useResult 链，
                // 只在原生牌对象上挂 token。这样翻面发生在 useCardBefore，而牌的实际效果仍由原生 useCard 结算。
                result.card.storage ||= {};
                result.card.storage.xd_zhuangzhou_token = token.id;
                token.card = result.card;
                Z.useTrace(token, "onuse已收到原生选牌结果");

                // V2.7.8：严禁在 onuse 阶段清空 result.cards 或 result.card.cards。
                // 此时本体尚未完成 useCard 事件的建立，提前清空会导致两种技能
                // 都只能翻面、不能产生实际牌效。普通牌的“留手、虚拟使用”改在
                // useCardBefore 成功翻面以后执行；装备/延时锦囊保留实体材料交给本体移动。
            },
            check(card) { return 8 - get.value(card); },
            ai: { order: 7, respondSha: true, respondShan: true,
                skillTagFilter(player, tag, arg) {
                    if (arg === "respond") return false;
                    const name = tag === "respondSha" ? "sha" : "shan";
                    if (!Z.allowed(player, mode)) return false;
                    if (mode === "awake" && !Z.v228CanAwake(player, get.event?.())) return false;
                    return player.getCards("h").some(card =>
                        Z.shown(card, player) === (mode === "dream") && get.name(card, player) === name
                    );
                },
            },
        });
    }

    Object.assign(lib.skill, skills);
    Object.assign(lib.translate, translate);

    game.addGlobalSkill("xd_zhuangzhou_engine");

    Z.character = {
        xd_zhuangzhou: [
            "male",
            "zhan_guo",
            3,
            skillIds,
            [],
        ],
    };

    Z.skills = skills;
    Z.translate = translate;

    return Z;
}
// 小型构造器只复用确实相同的字段；每个技能仍得到自己的 trigger/group/intro 对象。
function wuqiSwitch() {
  return {
    locked: true,
    forced: true,
    zhuanhuanji: true,
    firstDo: true,
    mark: true,
    marktext: "☯",
    init(player, skill) {
      player.storage[skill] ??= false; // false=阳，true=阴；百炼位置独立保存。
      lib.xd_utils.initWuqi(player);
    },
    intro: {
      nocount: true,
      content(storage, player) {
        const u = lib.xd_utils;
        return "当前项：" + (storage ? "阴" : "阳") + "<br>X：" + u.getWuqiX(player) + "<br>百炼：" + u.getWuqiPositionLabel(u.getWuqiBailianPosition(player));
      }
    },
    // 闪等牌在部分流程走 respond，两个入口均须保留。
    trigger: {
      player: ["useCard", "respond"]
    },
    async content(event, trigger, player) {
      await lib.xd_utils.resolveWuqiYang(player, trigger, event.name);
    }
  };
}
function caiyanRecord() {
  return {
    ...silentSkill,
    locked: true,
    mark: true,
    init(player, skill) {
      player.storage[skill + "_seen"] = 0;
      // acquiring 确保 init 早于 hasSkill 更新时也记录获得当下；不回读任何旧历史。
      lib.xd_utils.recordCaiyanHandState(player, skill);
    },
    onremove(player, skill) {
      delete player.storage[skill + "_seen"];
    },
    // 各技能独立注册/移除触发器，避免依赖本体对共享 group 的引用计数。
    trigger: {
      player: ["gainAfter", "loseAfter", "useCardBefore", "respondBefore", "phaseAnyBegin"],
      global: "loseAsyncAfter"
    },
    content(event, trigger, player) {
      lib.xd_utils.recordCaiyanHandState(player);
    }
  };
}
function caiyanAwakening() {
  return {
    juexingji: true,
    forced: true,
    skillAnimation: true,
    animationColor: "water",
    async content(event, trigger, player) {
      await lib.xd_utils.resolveCaiyanAwakening(player, event.name);
    }
  };
}
// 彭越：仅依据 2026-09-21 本次确认的规则重新实现。
function createXdPengyue() {
  const P = {
    // 以 0.1 为整数单位；基础文本、累计增量、消耗分别记账。
    state(player) {
      const s = player.storage.xd_pengyue ||= {
        base: 5, step: 1, bonus: 0, spent: 0, reserved: 0,
        round: game.roundNumber || 0, limits: {}
      };
      if (s.round !== (game.roundNumber || 0)) {
        s.round = game.roundNumber || 0;
        s.spent = 0;
      }
      return s;
    },
    remaining(player) {
      const s = P.state(player);
      return s.base + s.bonus - s.spent - s.reserved;
    },
    active(player) {
      return !!player?.hasSkill("xd_liebing") && P.remaining(player) >= 10;
    },
    bonus(player) {
      return player?.storage?.xd_pengyue?.bonus || 0;
    },
    fmt(tenths) { return (tenths / 10).toFixed(1); },
    sync(player) {
      player.syncStorage("xd_pengyue");
      if (player.hasSkill("xd_liebing")) player.markSkill("xd_liebing");
      if (player.hasSkill("xd_naoji")) player.markSkill("xd_naoji");
      player.addTip?.("xd_pengyue", "裂兵余 " + P.fmt(P.remaining(player)) +
        " · 累计+" + P.fmt(P.state(player).bonus));
    },
    hand(card, player) {
      if (get.itemtype(card) !== "card") return false;
      if (player.getCards("h").includes(card)) return true;
      // 木牛流马明确视为手牌；不把所有特殊区一概当成手牌。
      return player.getVCards?.("e", c => c.name === "muniu")
        .some(c => c.storages?.includes(card)) || false;
    },
    targetKinds: {
      // 原有的杀（包括任意属性）、闪、无懈均不转化，也不消耗裂兵次数。
      sha: 0, shan: 0, wuxie: 0,
      tao: 1, jiu: 1, wuzhong: 1, shandian: 1,
      shunshou: 2, guohe: 2, juedou: 2, jiedao: 2,
      nanman: 2, wanjian: 2, lebu: 2, bingliang: 2,
      huogong: 3, tiesuo: 3, wugu: 3, taoyuan: 3,
      dongzhuxianji: 1, xietianzi: 1,
      zhujinqiyuan: 2, chuqibuyi: 2, yuanjiao: 2, zhibi: 2,
      diaohulishan: 2, shuiyanqijunx: 2, gz_haolingtianxia: 2,
      yiyi: 3, lulitongxin: 3, chiling: 3, lianjunshengyan: 3
    },
    // 1=仅自己，2=仅他人，3=两者，0=豁免转化或无角色目标。
    // 标准/军争用静态固有规则，不根据本局伤势、手牌、距离探测分类。
    kind(card) {
      const name = card.name, info = lib.card[name] || {};
      if (Object.hasOwn(P.targetKinds, name)) return P.targetKinds[name];
      if ([0, 1, 2, 3].includes(info.xd_liebingTarget)) return info.xd_liebingTarget;
      if (name === "huxinjing") return get.mode() === "guozhan" ? 1 : 3;
      if (name === "huoshaolianying") return get.mode() === "guozhan" ? 3 : 2;
      if (info.toself || info.type === "equip" && info.toself !== false) return 1;
      if (info.notarget) return 0;
      if (info.filterTarget === true) return 3;
      // 常见扩展牌沿用原生 self/other 身份条件；不执行目标当前状态条件。
      if (typeof info.filterTarget === "function") {
        const source = Function.prototype.toString.call(info.filterTarget);
        const args = source.match(/^[^(]*\(([^)]*)\)/)?.[1].split(",").map(s => s.trim());
        if (args?.length >= 3) {
          const [, a, b] = args;
          const has = op => new RegExp("\\b(?:" + a + "\\s*" + op + "\\s*" + b + "|" + b + "\\s*" + op + "\\s*" + a + ")\\b").test(source);
          // “若等于自己则 return false”与“return 等于自己”含义相反。
          const noSpace = source.replace(/\s+/g, "");
          if (noSpace.includes("if(" + a + "===" + b + "){returnfalse") ||
              noSpace.includes("if(" + b + "===" + a + "){returnfalse")) return 2;
          if (noSpace.includes("if(" + a + "!==" + b + "){returnfalse") ||
              noSpace.includes("if(" + b + "!==" + a + "){returnfalse")) return 1;
          if (has("!==?")) return 2;
          if (has("===?")) return 1;
        }
        return 3;
      }
      return 0;
    },
    names(card) {
      const kind = P.kind(card);
      return [kind & 1 ? "wuzhong" : null, kind & 2 ? "sha" : null].filter(Boolean);
    },
    virtual(card, name) {
      return { name, nature: false, isCard: true, cards: [card],
        suit: get.suit(card), number: get.number(card),
        storage: { xd_liebing: true } };
    },
    chooseContext(player) {
      const e = _status.event;
      return e?.name === "chooseToUse" && e.player === player ? e : null;
    },
    can(card, name, player, event) {
      const v = P.virtual(card, name);
      const filter = event._xd_py?.filter || event.filterCard;
      if (typeof filter === "function" && !filter.call(event, v, player, event)) return false;
      if (!lib.filter.cardEnabled(v, player, event) || !lib.filter.cardUsable(v, player, event)) return false;
      const ft = event._xd_py?.targetFilter || event.filterTarget || lib.filter.filterTarget;
      if (name === "wuzhong") return ft.call(event, v, player, player) && lib.filter.targetEnabled2(v, player, player);
      return game.hasPlayer(t => t !== player && ft.call(event, v, player, t) && lib.filter.filterTarget(v, player, t));
    },
    effective(card, player) {
      const e = P.chooseContext(player);
      if (!e || P.costProbe || e.skill && e.skill !== "xd_liebing_use" ||
        !P.active(player) || !P.hand(card, player)) return;
      const names = P.names(card);
      if (!names.length) return;
      if (e._xd_py?.material === card && e._xd_py.choice) return e._xd_py.choice;
      if (names.length === 1) return names[0];
      // 未点牌时仅供原生可选性/AI判断；真人点牌后必须询问两种分支。
      if (P.probing) return names[0];
      P.probing = true;
      try { return names.find(n => P.can(card, n, player, e)) || names[0]; }
      finally { P.probing = false; }
    },
    clearCache(e) {
      for (const key of ["_cardChoice", "_targetChoice", "_skillChoice"]) delete e[key];
    },
    closeMenu(e) {
      const q = e._xd_py;
      q?.controls?.forEach(control => control.close()); q?.dialog?.close();
      if (q) { q.controls = []; q.dialog = null; q.menu = false; }
    },
    // 仅接管本次询问的卡牌点击；按钮、目标选择、确定、取消均沿用原生组件。
    setup(e) {
      if (!e?.player || e._xd_py || typeof e.filterCard !== "function") return;
      const p = e.player;
      const q = e._xd_py = { filter: e.filterCard, targetFilter: e.filterTarget,
        material: null, choice: null, menu: false };
      e.custom ||= { add: {}, replace: {} };
      e.custom.add ||= {}; e.custom.replace ||= {};
      const previousCard = e.custom.replace.card;
      const previousConfirm = e.custom.replace.confirm;
      const previousAddConfirm = e.custom.add.confirm;
      const originalRestore = e.restore;
      e.restore = function () {
        P.closeMenu(e);
        q.material = null; q.choice = null;
        const result = originalRestore.apply(this, arguments);
        P.clearCache(e);
        return result;
      };
      const nativeClick = card => {
        const own = e.custom.replace.card;
        const clicked = _status.clicked;
        if (previousCard) e.custom.replace.card = previousCard;
        else delete e.custom.replace.card;
        // 仅在重入原生 card() 时临时放行。恢复后交由 window() 消耗点击标记，
        // 否则同一次点击冒泡时会被当成空白点击，立即取消刚选的牌或转化。
        _status.clicked = false;
        try { ui.click.card.call(card); }
        finally { e.custom.replace.card = own; _status.clicked = clicked; }
      };
      const select = (card, name, immediate) => {
        P.closeMenu(e);
        if (_status.event !== e || !P.active(p) || !P.hand(card, p) || !P.can(card, name, p, e)) {
          q.material = null; q.choice = null;
          if (_status.event === e) { P.clearCache(e); game.check(); }
          return;
        }
        game.uncheck();
        q.material = card; q.choice = name;
        e.backup("xd_liebing_use");
        // backup 保存原 filterTarget；不覆盖回合外特定询问对目标的限制。
        P.clearCache(e); game.check();
        nativeClick(card);
        // 无中选择即提交；杀沿用原生自动确认与目标数量规则。
        if (immediate && _status.event === e && !e.result?.bool && game.check() && !e.result?.bool) ui.click.ok();
      };
      e.custom.replace.card = function (card) {
        if (q.menu) return;
        if (e.skill === "xd_liebing_use") {
          if (card === q.material && ui.selected.cards.includes(card)) {
            game.uncheck(); e.restore(); game.check();
          } else nativeClick(card);
          return;
        }
        if (e.skill || !P.active(p) || !P.hand(card, p) || !P.kind(card)) {
          nativeClick(card); return;
        }
        const names = P.names(card);
        if (!names.some(n => P.can(card, n, p, e))) return;
        if (names.length === 1) { select(card, names[0], names[0] === "wuzhong"); return; }
        game.uncheck();
        q.menu = true;
        q.dialog = ui.create.dialog("裂兵：" + get.translation(card.name), "选择此牌的使用方式");
        const choose = link => {
          if (link === "取消") {
            P.closeMenu(e); q.material = null; q.choice = null;
            P.clearCache(e); game.check(); return;
          }
          const name = link === "杀" ? "sha" : "wuzhong";
          if (P.can(card, name, p, e)) select(card, name, name === "wuzhong");
        };
        // 与原生 chooseControl 的 seperate 模式相同，每个选项独立一个控件。
        q.controls = ["无中生有", "杀", "取消"].map(label => ui.create.control(label, choose));
        // 非法分支保留可见、禁用点击，避免玩家误以为分类随场上状态变化。
        for (const control of q.controls) {
          const node = control.firstChild;
          if (!node) continue;
          const name = node.link === "杀" ? "sha" : node.link === "无中生有" ? "wuzhong" : null;
          if (name && !P.can(card, name, p, e)) {
            control.classList.add("disabled");
            node.classList.add("disabled"); node.style.opacity = "0.4";
          }
        }
      };
      e.custom.replace.confirm = function (ok) {
        if (q.menu) { P.closeMenu(e); P.clearCache(e); game.check(); return; }
        // 已选杀的取消：恢复选牌，不结束出牌阶段。
        if (!ok && e.skill === "xd_liebing_use") {
          game.uncheck(); e.restore(); game.check(); return;
        }
        const own = e.custom.replace.confirm;
        if (previousConfirm) e.custom.replace.confirm = previousConfirm;
        else delete e.custom.replace.confirm;
        try { (ok ? ui.click.ok : ui.click.cancel)(); }
        finally { e.custom.replace.confirm = own; }
      };
      e.custom.add.confirm = function (ok) {
        P.closeMenu(e);
        previousAddConfirm?.call(this, ok);
      };
      // 临时 UI 在询问结束/托管/取消之后清理，不跨询问共享材料或分支。
      const cleanup = game.createEvent("xd_pengyue_choose_cleanup", false);
      e.next?.remove(cleanup);
      _status.event?.next?.remove(cleanup);
      e.after.push(cleanup);
      cleanup.setContent(async () => P.closeMenu(e));
    },
    async beforeUse(event, player) {
      if (!P.active(player) || event._xd_py_reserved) return;
      const cards = (event.cards || []).filter(c => P.hand(c, player));
      if (!cards.length || cards.every(c => !P.kind(c))) return;
      // 正常原生入口已经完成选牌/选目标；直接 useCard 的技能也在这里受锁定规则约束。
      let names = cards.reduce((list, card) => list.filter(n => P.names(card).includes(n)), ["wuzhong", "sha"]);
      if (!names.length) { event.cancel(); return; }
      const parent = event.getParent?.("chooseToUse");
      let chosen = event.card?.storage?.xd_liebing ? event.card.name :
        event.modSkill?.cardname === "xd_liebing" ? event.card.name : null;
      if (!names.includes(chosen)) {
        // 原本直接使用的桃/酒不能在濒死事件中绕过检查。
        if (parent?.type === "dying" || parent?.dying) { event.cancel(); return; }
        names = names.filter(n => player.hasUseTarget(P.virtual(cards[0], n)));
        if (!names.length) { event.cancel(); return; }
        if (names.length === 2) {
          const r = await player.chooseControl("无中生有", "杀").set("prompt", "裂兵：选择强制转化的牌").forResult();
          chosen = r.control === "杀" ? "sha" : "wuzhong";
        } else chosen = names[0];
        const v = P.virtual(cards[0], chosen);
        if (chosen === "wuzhong") event.targets = [player];
        else {
          const r = await player.chooseTarget("裂兵：选择【杀】的目标", true,
            (card, p, t) => t !== p && p.canUse(_status.event._xd_card, t))
            .set("_xd_card", v).set("ai", t => get.effect(t, v, player, player)).forResult();
          if (!r.bool) { event.cancel(); return; }
          event.targets = r.targets;
        }
        event.card = { ...v, cards: event.cards.slice() };
        // 清除原借刀等双目标牌在 useCard 创建时设置的中间状态。
        for (const key of ["_targets", "target", "addedTargets", "addedTarget"]) delete event[key];
      }
      // 预留在真实使用确认之后；useCard0 提交，若 useCardBefore 被取消则退回。
      P.state(player).reserved += 10;
      event._xd_py_reserved = true;
      const cleanup = game.createEvent("xd_pengyue_use_cleanup", false);
      _status.event.next?.remove(cleanup);
      event.after.push(cleanup);
      cleanup.setContent(async () => {
        if (event._xd_py_reserved) {
          P.state(player).reserved -= 10;
          event._xd_py_reserved = false;
          P.sync(player);
        }
      });
      P.sync(player);
    },
    // 原生 usable 为每回合/每阶段次数；让值仍随当前玩家求值，不改其他人的额度。
    wrapUsable(info) {
      if (!info || info._xd_py_usable || info.usable === undefined) return;
      const base = info.usable;
      info.usable = function (skill, player) {
        const value = typeof base === "function" ? base.apply(this, arguments) : base;
        return typeof value === "number" && P.bonus(player) ? Math.floor((value * 10 + P.bonus(player)) / 10 + 1e-9) : value;
      };
      info._xd_py_usable = true;
    },
    wrapOwned(player) {
      for (const id of game.expandSkills(player.getSkills(true).slice())) P.wrapUsable(lib.skill[id]);
    },
    roundAllowance(player, id, period) {
      const s = P.state(player), now = game.roundNumber || 0;
      let rec = s.limits[id];
      if (rec && now - rec.start >= period) rec = null;
      if (!rec) {
        const last = player.storage[id + "_roundcount"];
        const recent = typeof last === "number" && now - last < period;
        rec = s.limits[id] = { start: recent ? last : now, used: recent ? 1 : 0 };
      }
      return rec;
    },
    install() {
      if (P.installed) return;
      P.installed = true;
      lib.xd_utils.pengyue = P;
      // 兼容原生 usable 与 round；硬编码在第三方 filter/storage 内的额度需该技能适配。
      for (const key of ["filterEnable", "filterTrigger"]) {
        const original = lib.filter[key];
        lib.filter[key] = function (event, player, ...args) {
          if (!player?.hasSkill("xd_naoji") && !P.bonus(player)) return original.apply(this, arguments);
          const id = key === "filterEnable" ? args[0] : args[1];
          const info = lib.skill[id];
          P.wrapUsable(info);
          const invoke = () => {
            const old = P.costProbe;
            // 普通技能选择弃牌、重铸等费用，不属于“使用这张牌”。
            P.costProbe = key === "filterEnable" && !info?.viewAs;
            try { return original.call(this, event, player, ...args); }
            finally { P.costProbe = old; }
          };
          if (!info?.round || P.bonus(player) < 10) return invoke();
          const period = info.round, rec = P.roundAllowance(player, id, period);
          if (rec.used >= 1 + Math.floor(P.bonus(player) / 10)) return false;
          info.round = 0;
          try { return invoke(); }
          finally { info.round = period; }
        };
      }
      lib.dynamicTranslate.xd_liebing = player => "锁定技，每轮限" + P.fmt(P.state(player).base) +
        "次，你仅能将目标为你/其他角色的手牌当【无中生有】/【杀】使用。<br>" +
        "本轮上限：" + P.fmt(P.state(player).base + P.state(player).bonus) +
        "；剩余：" + P.fmt(P.remaining(player)) + "。原有杀（保留属性）、闪与无懈可击不变；打出不变。";
      lib.dynamicTranslate.xd_naoji = player => "锁定技，你使用牌后攻击范围、攻击频率、技能限制次数+" +
        P.fmt(P.state(player).step) + "，你造成伤害后翻倍你一个技能的数值。<br>整局累计增加：" + P.fmt(P.state(player).bonus) + "。";
    }
  };
  const skills = {
    xd_liebing: {
      locked: true, forced: true, mark: true, marktext: "裂",
      init(player) { P.state(player); P.sync(player); },
      onChooseToUse(event) { P.setup(event); },
      intro: {
        markcount(storage, p) { return P.fmt(P.remaining(p)); },
        content(storage, p) { return lib.dynamicTranslate.xd_liebing(p); }
      },
      mod: {
        cardname(card, player) { return P.effective(card, player); },
        cardnature(card, player) { if (P.effective(card, player)) return false; },
        cardEnabled2(card, player) {
          const e = P.chooseContext(player);
          if (e?.skill && e.skill !== "xd_liebing_use" && lib.skill[e.skill]?.viewAs &&
            P.active(player) && P.hand(card, player) && P.kind(card)) return false;
        },
        cardSavable(card, player) {
          const cards = get.itemtype(card) === "card" ? [card] : card.cards || [];
          if (P.active(player) && cards.some(c => P.hand(c, player) && P.kind(c))) return false;
        }
      },
      group: ["xd_liebing_before", "xd_liebing_commit", "xd_liebing_round"],
      subSkill: {
        before: {
          ...silentRule, firstDo: true, priority: 1000,
          trigger: { player: "useCardBefore" },
          async content(event, trigger, player) { await P.beforeUse(trigger, player); }
        },
        commit: {
          ...silentRule, firstDo: true, priority: 1000,
          trigger: { player: "useCard0" },
          filter(event) { return !!event._xd_py_reserved; },
          content(event, trigger, player) {
            const P = lib.xd_utils.pengyue;
            const s = P.state(player); s.reserved -= 10; s.spent += 10;
            trigger._xd_py_reserved = false;
            trigger._xd_py_used = true;
            player.logSkill("xd_liebing"); P.sync(player);
          }
        },
        round: {
          ...silentRule, trigger: { global: "roundStart" },
          content(event, trigger, player) {
            const P = lib.xd_utils.pengyue;
            P.state(player); P.sync(player);
          }
        }
      }
    },
    // 只有直接点手牌才进入此原生 backup；不显示额外技能按钮。
    xd_liebing_use: {
      charlotte: true, log: false,
      position: "hs", selectCard: 1,
      filterCard(card, player) {
        const e = _status.event, q = e._xd_py;
        return P.active(player) && card === q?.material && P.can(card, q.choice, player, e);
      },
      viewAs(cards) {
        const q = _status.event._xd_py;
        if (q?.material && q.choice) return P.virtual(q.material, q.choice);
      },
      filterTarget(card, player, target) {
        const e = _status.event;
        if (card.name === "sha" && target === player || card.name === "wuzhong" && target !== player) return false;
        return lib.filter.filterTarget(card, player, target) &&
          (!e._xd_py.targetFilter || e._xd_py.targetFilter.call(e, card, player, target));
      },
      selectTarget() {
        return _status.event._xd_py?.choice === "wuzhong" ? -1 : lib.filter.selectTarget(get.card(), get.player());
      }
    },
    xd_naoji: {
      locked: true, forced: true, mark: true, marktext: "挠",
      init(player) {
        P.state(player); player.addSkill("xd_pengyue_growth");
        P.wrapOwned(player); P.sync(player);
      },
      onChooseToUse(event) { P.wrapOwned(event.player); },
      trigger: { player: "useCardAfter", source: "damageSource" },
      filter(event) { return event.name !== "damage" || event.num > 0; },
      async content(event, trigger, player) {
        const s = P.state(player);
        if (trigger.name !== "damage") {
          s.bonus += s.step;
          P.wrapOwned(player); P.sync(player);
          return;
        }
        const ids = ["xd_liebing", "xd_naoji"].filter(id => player.hasSkill(id));
        const controls = ids.map(id => get.translation(id));
        let index = 0;
        if (ids.length > 1) {
          const r = await player.chooseControl(controls)
            .set("prompt", "挠击：翻倍一个技能的文本数值")
            .set("choiceList", ["裂兵：" + P.fmt(s.base) + " → " + P.fmt(s.base * 2),
              "挠击：" + P.fmt(s.step) + " → " + P.fmt(s.step * 2)])
            .set("ai", () => 1).forResult();
          index = Math.max(0, controls.indexOf(r.control));
        }
        if (ids[index] === "xd_liebing") s.base *= 2;
        else s.step *= 2;
        game.log(player, "将", "#g" + get.translation(ids[index]), "的文本数值翻倍");
        P.sync(player);
      },
      intro: { content(storage, p) { return lib.dynamicTranslate.xd_naoji(p); } },
      subSkill: {
        limits: {
          ...silentRule, trigger: { player: "logSkillBegin" },
          filter(event) { return !!lib.skill[event.skill]?.round; },
          content(event, trigger, player) {
            const P = lib.xd_utils.pengyue;
            const id = trigger.skill, period = lib.skill[id].round;
            // logSkill 已写 _roundcount；新记录的这一次只记 1，不重复加。
            const old = P.state(player).limits[id];
            if (!old || (game.roundNumber || 0) - old.start >= period) {
              P.state(player).limits[id] = { start: game.roundNumber || 0, used: 1 };
            } else {
              if (!old.used) old.start = game.roundNumber || 0;
              old.used++;
            }
            P.sync(player);
          }
        }
      }
    }
  };
  // 已经获得的数值是整局收益；以后失去【挠击】不会收回既有收益。
  skills.xd_pengyue_growth = {
    charlotte: true, popup: false,
    group: "xd_naoji_limits",
    mod: {
      attackRange(player, num) { return Math.floor((num * 10 + P.bonus(player)) / 10 + 1e-9); },
      cardUsable(card, player, num) {
        if (card.name === "sha" && typeof num === "number") return Math.floor((num * 10 + P.bonus(player)) / 10 + 1e-9);
      }
    }
  };
  return { P, skills };
}



// 玄蝶当前帖子版的8名旧将：直接复用本体未改动技能，只覆盖人物规格与发生变化的技能。
// 使用本体原 character ID，避免同名复制；扩展开启时以本帖规则覆盖本体现行版本。
function createXdLegacyPack() {
  const characters = {
    clan_xunshu: {
      sex: "male", group: "han", hp: 3,
      skills: ["clanshenjun", "clanbalong"],
      clans: ["颍川荀氏"],
      img: "image/character/clan_xunshu.jpg"
    },
    zhangzhi: {
      sex: "male", group: "han", hp: 3,
      skills: ["olbixin", "olximo"],
      img: "image/character/zhangzhi.jpg"
    },
    ol_pengyang: {
      sex: "male", group: "han", hp: 3,
      skills: ["olxiaofan", "oltuishi", "nzry_cunmu"],
      img: "image/character/ol_pengyang.jpg"
    },
    ol_mengda: {
      sex: "male", group: "han", hp: 4,
      skills: ["olgoude"],
      img: "image/character/ol_mengda.jpg"
    },
    sp_menghuo: {
      sex: "male", group: "han", hp: 4,
      skills: ["spmanwang"],
      img: "image/character/sp_menghuo.jpg"
    },
    clan_wuxian: {
      sex: "female", group: "han", hp: 3,
      skills: ["clanyirong", "clanguixiang"],
      clans: ["陈留吴氏"],
      img: "image/character/clan_wuxian.jpg"
    },
    luoxian: {
      sex: "male", group: "han", hp: 4,
      skills: ["oldaili"],
      img: "image/character/luoxian.jpg"
    },
    zhanghua: {
      sex: "male", group: "jin", hp: 3,
      skills: ["olbihun", "oljianhe", "olchuanwu"],
      img: "image/character/zhanghua.jpg"
    }
  };

  const characterTranslate = {
    clan_xunshu: "荀淑",
    clan_xunshu_prefix: "",
    zhangzhi: "张芝",
    ol_pengyang: "彭羕",
    ol_mengda: "孟达",
    ol_mengda_prefix: "",
    sp_menghuo: "孟获",
    sp_menghuo_prefix: "",
    clan_wuxian: "吴苋",
    clan_wuxian_prefix: "",
    luoxian: "罗宪",
    zhanghua: "张华"
  };

  const characterIntro = {
    clan_xunshu: "驾八龙之婉婉兮，载云旗之委蛇。",
    zhangzhi: "匆匆不暇草，匆匆不暇草。",
    ol_pengyang: "诸君食肉而鄙，空有大腹作碍。",
    ol_mengda: "天地有时饶一掷，江山论主合平分。",
    sp_menghuo: "但觉胸吞云海，不知身落南蛮。",
    clan_wuxian: "去年杨花似飞雪，故穿庭树作飞花。",
    luoxian: "料山河，见我应啼血。",
    zhanghua: "物华天宝，龙光射牛斗之墟。"
  };

  const characterTitle = {
    clan_xunshu: "长儒赡宗",
    zhangzhi: "草圣",
    ol_pengyang: "枕流漱石",
    ol_mengda: "腾挪反复",
    sp_menghuo: "夷汉并服",
    clan_wuxian: "庄姝晏晏",
    luoxian: "介然毕命",
    zhanghua: "双剑化龙"
  };

  const skillTranslate = {
    clanshenjun: "神君",
    clanshenjun_info: "锁定技，当即时牌被使用时，你明置同名牌，本阶段结束时，你将明置牌数张牌当任意明置牌使用。",
    clanbalong: "八龙",
    clanbalong_info: "锁定技，当你每回合体力值首次变化后，若锦囊牌为你唯一最多的手牌类型，你展示手牌并摸至八张。",
    oltuishi: "侻失",
    oltuishi_info: "转换技，锁定技，你的字母点数牌视为阳：【酒】；阴：【无中生有】，然后你下次使用牌无距离次数限制。",
    clanguixiang: "贵相",
    clanguixiang_info: "锁定技，你回合内第X+1个阶段改为出牌阶段（X为你的手牌上限）。",
    olchuanwu: "穿屋",
    olchuanwu_info: "锁定技。当你造成伤害后，你令武将牌上的前X个未失效的技能失效直到回合结束。然后你摸等同于你此次失效的技能数张牌（X为你的攻击范围）。"
  };

  const skills = {
    // 荀淑【神君】：真正使用本体“明置手牌”状态，不再另造“神君牌”标签。
    clanshenjun: {
      audio: 2,
      trigger: { global: "useCard" },
      forced: true,
      filter(event, player) {
        if (!event?.card) return false;
        const type = get.type(event.card, null, false);
        if (type !== "basic" && type !== "trick") return false;
        const name = event.card.name || get.name(event.card, false);
        if (!name) return false;
        return player.getCards("h").some(card => get.name(card, player) === name);
      },
      getShownCards(player) {
        if (lib.xd_utils?.getShownHandCards) return lib.xd_utils.getShownHandCards(player);
        return player.getCards("h", card => {
          try { return !!get.is?.shownCard?.(card); } catch (e) { return false; }
        });
      },
      getVCardList(player) {
        const shown = lib.skill.clanshenjun.getShownCards(player);
        const list = [], seen = new Set();
        for (const card of shown) {
          const name = get.name(card, player);
          const nature = get.nature(card, player) || "";
          if (!name) continue;
          const key = name + "|" + nature;
          if (seen.has(key)) continue;
          const vcard = { name, isCard: true };
          if (nature) vcard.nature = nature;
          try {
            if (!player.hasUseTarget(vcard)) continue;
          } catch (e) {
            continue;
          }
          seen.add(key);
          list.push(nature ? [get.type(card, null, false), "", name, nature] : [get.type(card, null, false), "", name]);
        }
        list.sort((a, b) => {
          const del = lib.inpile.indexOf(a[2]) - lib.inpile.indexOf(b[2]);
          if (del) return del;
          return String(a[3] || "").localeCompare(String(b[3] || ""));
        });
        return list;
      },
      async content(event, trigger, player) {
        const name = trigger.card.name || get.name(trigger.card, false);
        const cards = player.getCards("h").filter(card => get.name(card, player) === name);
        if (cards.length) {
          if (lib.xd_utils?.revealHandCards) {
            await lib.xd_utils.revealHandCards(player, cards, "visible_clanshenjun", "发动了【神君】");
          } else {
            await player.showCards(cards, get.translation(player) + "发动了【神君】");
            if (typeof player.addShownCards === "function") await player.addShownCards(cards, "visible_clanshenjun");
          }
        }
        for (const phaseName of lib.phaseName) {
          const phase = event.getParent(phaseName);
          if (!phase || phase.name !== phaseName) continue;
          player.addTempSkill("clanshenjun_viewAs", phaseName + "After");
          break;
        }
      },
      subSkill: {
        viewAs: {
          audio: "clanshenjun",
          trigger: { global: ["phaseZhunbeiEnd", "phaseJudgeEnd", "phaseDrawEnd", "phaseUseEnd", "phaseDiscardEnd", "phaseJieshuEnd"] },
          forced: true,
          charlotte: true,
          filter(event, player) {
            return lib.skill.clanshenjun.getShownCards(player).length > 0 && lib.skill.clanshenjun.getVCardList(player).length > 0;
          },
          async content(event, trigger, player) {
            const shown = lib.skill.clanshenjun.getShownCards(player);
            const num = shown.length;
            const list = lib.skill.clanshenjun.getVCardList(player);
            if (!num || !list.length) return;
            const result = await player
              .chooseButton(["神君：将" + get.cnNumber(num) + "张牌当任意明置牌使用", [list, "vcard"]], true)
              .set("ai", button => get.player().getUseValue({ name: button.link[2], nature: button.link[3] }))
              .forResult();
            if (!result?.bool || !result.links?.length) return;
            const name = result.links[0][2], nature = result.links[0][3];
            game.broadcastAll((count, card) => {
              lib.skill.clanshenjun_backup.selectCard = count;
              lib.skill.clanshenjun_backup.viewAs = card;
            }, num, { name, nature });
            const next = player.chooseToUse();
            next.set("openskilldialog", "神君：将" + get.cnNumber(num) + "张牌当" + (get.translation(nature) || "") + "【" + get.translation(name) + "】使用");
            next.set("forced", true);
            next.set("norestore", true);
            next.set("addCount", false);
            next.set("_backupevent", "clanshenjun_backup");
            next.set("custom", { add: {}, replace: { window() {} } });
            next.backup("clanshenjun_backup");
            await next.forResult();
          }
        },
        backup: {
          filterCard(card) {
            return get.itemtype(card) === "card";
          },
          position: "hes",
          filterTarget: lib.filter.filterTarget,
          check: card => 6 - get.value(card),
          log: false
        }
      }
    },

    // 荀淑【八龙】：沿用本体现行首次体力变化判定，仅把摸牌目标改为固定八张。
    clanbalong: {
      audio: 2,
      trigger: { player: ["damageEnd", "recoverEnd", "loseHpEnd"] },
      forced: true,
      filter(event, player) {
        if (game.getGlobalHistory("changeHp", evt => evt.player === player).length !== 1) return false;
        const cards = player.getCards("h"), map = {};
        if (!cards.length) return false;
        for (const card of cards) {
          const type = get.type2(card);
          map[type] = (map[type] || 0) + 1;
        }
        const list = Object.entries(map).filter(item => item[1] > 0).sort((a, b) => b[1] - a[1]);
        return list[0]?.[0] === "trick" && (list.length === 1 || list[0][1] > list[1][1]);
      },
      content() {
        player.showHandcards(get.translation(player) + "发动了【八龙】");
        player.drawTo(8);
      }
    },

    // 彭羕【侻失】：新帖版彻底替换旧版“牌无效/摸牌/禁无懈/封嚣翻”逻辑。
    oltuishi: {
      audio: 2,
      zhuanhuanji: true,
      forced: true,
      mark: true,
      marktext: "☯",
      intro: {
        content(storage) {
          return "转换技，锁定技。你的字母点数牌视为" + (storage ? "【无中生有】" : "【酒】") + "；以此法使用牌后，你转换此技能，然后你下次使用牌无距离次数限制。";
        }
      },
      isLetter(card, player) {
        if (!card) return false;
        const num = get.number(card, player);
        return typeof get.strNumber(num, false) === "string";
      },
      expectedName(player) {
        return player.storage.oltuishi ? "wuzhong" : "jiu";
      },
      mod: {
        cardname(card, player) {
          if (get.itemtype(card) !== "card") return;
          let owned = false;
          try { owned = player.getCards("hs").includes(card); } catch (e) {}
          if (!owned || !lib.skill.oltuishi.isLetter(card, player)) return;
          return lib.skill.oltuishi.expectedName(player);
        },
        aiOrder(player, card, order) {
          if (get.itemtype(card) === "card" && lib.skill.oltuishi.isLetter(card, player)) return order + 3;
        }
      },
      trigger: { player: "useCardAfter" },
      filter(event, player) {
        if (!event?.card || !Array.isArray(event.cards) || event.cards.length !== 1) return false;
        const physical = event.cards[0];
        if (get.itemtype(physical) !== "card" || !lib.skill.oltuishi.isLetter(physical, player)) return false;
        // 这里只认直接使用被【侻失】改名的实体牌，不把其他技能拿字母牌作材料的虚拟牌误算进去。
        if (event.skill || event.card.skill) return false;
        const expected = lib.skill.oltuishi.expectedName(player);
        const actual = event.card.name || get.name(event.card, player);
        return actual === expected;
      },
      content() {
        player.changeZhuanhuanji("oltuishi");
        player.addSkill("oltuishi_unlimit");
      },
      subSkill: {
        unlimit: {
          charlotte: true,
          mark: true,
          marktext: "侻",
          intro: { content: "使用下一张牌无距离和次数限制" },
          mod: {
            targetInRange() { return true; },
            cardUsable() { return Infinity; }
          },
          trigger: { player: "useCard1" },
          forced: true,
          popup: false,
          silent: true,
          firstDo: true,
          content(event, trigger, player) {
            player.removeSkill("oltuishi_unlimit");
            if (trigger.addCount !== false) {
              trigger.addCount = false;
              const stat = player.getStat().card, name = trigger.card.name;
              if (typeof stat[name] === "number") stat[name]--;
            }
          }
        }
      }
    },

    // 吴苋【贵相】：本体现行“第X个阶段”整体后移一位为“第X+1个阶段”。
    clanguixiang: {
      audio: 2,
      trigger: { player: "phaseChange" },
      forced: true,
      filter(event, player) {
        if (event.phaseList[event.num].startsWith("phaseUse")) return false;
        const num1 = player.getHandcardLimit(),
          num2 = event.num - player.getHistory("skipped").length;
        return num1 === num2;
      },
      content() {
        trigger.phaseList[trigger.num] = `phaseUse|${event.name}`;
        game.delayx();
      }
    },

    // 张华【穿屋】：只删除“受到伤害后”入口，其余本体结算原样保留。
    olchuanwu: {
      audio: 2,
      trigger: { source: "damageSource" },
      forced: true,
      filter(event, player) {
        return player.getAttackRange() > 0;
      },
      content() {
        let skills = game.filterSkills(
          player.getStockSkills(true, true).filter(skill => {
            const info = get.info(skill);
            return !info.persevereSkill || !info.charlotte;
          }),
          player
        );
        const num = Math.min(player.getAttackRange(), skills.length);
        skills = skills.slice(0, num);
        player.disableSkill("olchuanwu", skills);
        player.addTempSkill("olchuanwu_restore");
        let str = "";
        for (const skill of skills) {
          str += "【" + get.translation(skill) + "】、";
          player.popup(skill);
        }
        str = str.slice(0, -1);
        game.log(player, "的技能", "#g" + str, "失效了");
        player.draw(num);
      },
      subSkill: {
        restore: {
          charlotte: true,
          forced: true,
          popup: false,
          onremove(player) {
            player.enableSkill("olchuanwu");
            game.log(player, "恢复了技能");
          }
        }
      }
    }
  };

  // 这8名角色在本扩展中已经是玄蝶当前帖子版，不再沿用本体原武将包来源。
  // 不改角色ID，以继续复用本体素材/未改技能；仅在扩展启用期间把“武将包归属”统一到《风雨如晦》（上）。
  function normalizePackSource() {
    const ids = Object.keys(characters);
    const packs = lib.characterPack || {};
    const ownKeys = new Set();

    // 扩展包的运行时key由无名杀生成，不硬编码；用本扩展独有武将反查。
    for (const [key, pack] of Object.entries(packs)) {
      if (!pack || typeof pack !== "object") continue;
      if (["xd_zhoudan", "xd_hanxin", "xd_limu"].some(id => Object.prototype.hasOwnProperty.call(pack, id))) {
        ownKeys.add(key);
      }
    }
    // 兼容不同无名杀版本生成的扩展包key。
    for (const key of Object.keys(packs)) {
      const label = lib.translate?.[key + "_character_config"];
      if (String(key).includes("风雨如晦") || (typeof label === "string" && label.includes("风雨如晦"))) {
        ownKeys.add(key);
      }
    }

    // 从原OL/族/SP等武将包中移除这8人的“来源索引”；不删除lib.character本身。
    for (const [key, pack] of Object.entries(packs)) {
      if (!pack || typeof pack !== "object" || ownKeys.has(key)) continue;
      for (const id of ids) {
        if (Object.prototype.hasOwnProperty.call(pack, id)) delete pack[id];
      }
    }

    // 同步清掉原包的分组索引，避免武将菜单仍把他们列回旧包。
    const sorts = lib.characterSort || {};
    for (const [packKey, groups] of Object.entries(sorts)) {
      if (ownKeys.has(packKey) || !groups || typeof groups !== "object") continue;
      for (const [groupKey, list] of Object.entries(groups)) {
        if (!Array.isArray(list)) continue;
        groups[groupKey] = list.filter(id => !ids.includes(id));
      }
    }

    // 明确将本扩展的武将包显示名统一为用户指定版本名。
    for (const key of ownKeys) {
      lib.translate[key + "_character_config"] = "《风雨如晦》（上）";
    }
  }

  function installRuntime() {
    Object.assign(lib.translate, characterTranslate, skillTranslate);
    lib.dynamicTranslate ||= {};
    lib.dynamicTranslate.oltuishi = function (player) {
      const yang = !player.storage.oltuishi;
      return "转换技，锁定技，你的字母点数牌视为"
        + (yang ? '<span class="bluetext">阳：【酒】</span>' : "阳：【酒】")
        + "；"
        + (!yang ? '<span class="bluetext">阴：【无中生有】</span>' : "阴：【无中生有】")
        + "，然后你下次使用牌无距离次数限制。";
    };
    lib.characterIntro ||= {};
    lib.characterTitle ||= {};
    Object.assign(lib.characterIntro, characterIntro);
    Object.assign(lib.characterTitle, characterTitle);
    for (const [id, data] of Object.entries(characters)) {
      lib.character[id] = { ...(lib.character[id] || {}), ...data };
    }
    // 主技能与需要按ID访问的子技能同时覆盖，避免本体同名旧实现残留。
    for (const [id, info] of Object.entries(skills)) {
      lib.skill[id] = info;
      for (const [sub, subInfo] of Object.entries(info.subSkill || {})) {
        lib.skill[id + "_" + sub] = { ...subInfo, sub: true, sourceSkill: id };
      }
    }
  }

  return { characters, characterTranslate, characterIntro, characterTitle, skillTranslate, skills, installRuntime, normalizePackSource };
}

export default function () {
  const pengyue = createXdPengyue();
  const legacy = createXdLegacyPack();
  return {
    name: "风雨如晦（上）",
    arenaReady: function () {
      legacy.installRuntime();
      legacy.normalizePackSource();
    },
    content: function (config, pack) {
      legacy.normalizePackSource();
    },
    prepare: function () {
      legacy.normalizePackSource();
    },
    precontent: function () {
      // 共享 faction ID；不覆盖先加载扩展设置的名称和颜色。
      for (const [id, name, color] of [["zhou", "周", "#C24835"], ["zhan_guo", "战国", "#896A40"], ["han", "汉", "#822F1F"], ["chu", "楚", "#76283C"], ["xin", "新", "#C3A13A"], ["qin", "秦", "#1B1B1C"], ["chun_qiu", "春秋", "#688572"], ["xia", "夏", "#252A30"]]) {
        if (!lib.group.includes(id)) lib.group.push(id);
        lib.translate[id] ??= name;
        lib.translate[id + "Color"] ??= color;
      }
      // 选将界面的自定义势力字不会像魏蜀吴群晋那样自动获得本体可识别的颜色属性。
      // 这里只给武将按钮右上角的势力字补一个本扩展私有标记，再复用本体式 text-shadow；
      // 不改筛选按钮、不改布局；汉使用本包既有汉色，晋继续沿用本体原生配色。
      if (typeof document !== "undefined" && !globalThis.__xdFactionBadgeColorInstalled) {
        globalThis.__xdFactionBadgeColorInstalled = true;
        const factionBadgeColors = {
          "周": ["zhou", "194,72,53"],
          "汉": ["han", "130,47,31"],
          "战国": ["zhan_guo", "137,106,64"],
          "楚": ["chu", "118,40,60"],
          "新": ["xin", "195,161,58"],
          "秦": ["qin", "70,70,72"],
          "春秋": ["chun_qiu", "104,133,114"],
          "夏": ["xia", "62,70,80"],
        };
        const style = document.createElement("style");
        style.id = "xd-faction-badge-colors";
        style.textContent = Object.values(factionBadgeColors).map(([id, rgb]) => `
          .button.character > .identity[data-xd-faction="${id}"],
          .button.character > .identity[data-xd-faction="${id}"] * {
            color: white !important;
            text-shadow: rgba(${rgb},1) 0 0 2px,
                         rgba(${rgb},1) 0 0 5px,
                         rgba(${rgb},1) 0 0 10px,
                         rgba(${rgb},1) 0 0 10px,
                         rgba(${rgb},1) 0 0 20px,
                         rgba(${rgb},1) 0 0 20px,
                         black 0 0 1px !important;
          }
        `).join("\n");
        document.head.appendChild(style);

        const markFactionBadges = () => {
          for (const node of document.querySelectorAll(".button.character > .identity")) {
            const label = (node.textContent || "").replace(/\\s+/g, "").trim();
            const entry = factionBadgeColors[label];
            if (entry) node.dataset.xdFaction = entry[0];
          }
        };
        let scheduled = false;
        const scheduleMark = () => {
          if (scheduled) return;
          scheduled = true;
          const run = () => {
            scheduled = false;
            markFactionBadges();
          };
          if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
          else setTimeout(run, 0);
        };
        scheduleMark();
        const observer = new MutationObserver(scheduleMark);
        observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
        globalThis.__xdFactionBadgeColorObserver = observer;
      }
      legacy.installRuntime();
      // 【欺暗】的“位置就是信息”不能依赖本体 choose/gain/discardPlayerCard 的默认牌窗。
      // 本体会把明置手牌与暗置手牌重新分组；即使真实手牌已经是 A→3→6→7→Q，
      // 选择窗口也可能把明置的 6 单独挪到最左侧。这里不再修补假牌按钮映射；
      // 在 installXdZhuangzhou 之后统一接管本机李斯自己的 player-card 选择事件，
      // 用原生 Dialog/Button 重新按“真实手牌位置”展示：明牌正面、暗牌原生牌背。

      // 公共工具只处理牌、显示与各自状态机；蔡琰的位置逻辑不进入通用明置判断。
      Object.assign(lib.xd_utils ??= {}, {
        isShownHandCard(card, player) {
          if (!card || !player || !player.getCards("h").includes(card)) return false;
          // 保留本体两种明置入口和旧 gaintag；离开手牌立即不再算明置手牌。
          try {
            if (get.is?.shownCard?.(card)) return true;
          } catch (e) {}
          try {
            if (player.getShownCards?.().includes(card)) return true;
          } catch (e) {}
          return typeof card.hasGaintag === "function" && ["xd_sijiao_tag", "xd_juemo_tag", "visible_xd_jiedu", "visible_xd_hujia", "visible_xd_qiming", "visible_clanshenjun"].some(tag => card.hasGaintag(tag));
        },
        getShownHandCards(player) {
          return player ? player.getCards("h", card => lib.xd_utils.isShownHandCard(card, player)) : [];
        },
        getUnshownHandCards(player) {
          return player ? player.getCards("h", card => !lib.xd_utils.isShownHandCard(card, player)) : [];
        },
        // event.cards → card.cards → 实体牌自身。提取材料不等于认定本次是实体用牌。
        getMaterialCards(card, event) {
          for (const source of [event?.cards, card?.cards, [card]]) {
            let cards;
            try {
              cards = Array.from(source ?? []);
            } catch (e) {
              continue;
            }
            cards = [...new Set(cards.filter(current => current && get.itemtype(current) === "card"))];
            if (cards.length) return cards;
          }
          return [];
        },
        // 通用牌名目录：候选只来自调用者传入的合法虚拟牌。
        // UI 使用无名杀本体 vcard 按钮；这里只补充分组、说明与滚动体验。
        getCardNameChoiceEntries(vcards) {
          const result = [];
          const seen = new Set();
          for (const info of vcards || []) {
            if (!info || !info[2]) continue;
            const name = info[2], nature = info[3] || null;
            const key = JSON.stringify([name, nature]);
            if (seen.has(key)) continue;
            seen.add(key);
            const card = get.autoViewAs({ name, nature, isCard: true }, "unsure");
            const type = get.type(card, null, false);
            let section = "other";
            if (type === "basic") {
              section = "basic";
            } else if (type === "delay") {
              section = "trick_delay";
            } else if (type === "trick") {
              let damage = false;
              try {
                damage = !!get.tag(card, "damage");
              } catch (e) {
                const tag = lib.card[name]?.ai?.tag?.damage;
                damage = typeof tag === "function" || !!tag;
              }
              section = damage ? "trick_damage" : "trick_utility";
            } else if (type === "equip") {
              const subtype = get.subtype(card);
              section = ({
                equip1: "equip_weapon",
                equip2: "equip_armor",
                equip3: "equip_horse_def",
                equip4: "equip_horse_atk",
                equip5: "equip_treasure"
              })[subtype] || "equip_other";
            }
            result.push({
              key, info, card, name, nature, type, section,
              label: get.translation(card) || get.translation(name)
            });
          }
          return result;
        },
        getCardNameChoiceEntry(vcards, key) {
          return lib.xd_utils.getCardNameChoiceEntries(vcards).find(item => item.key === key) || null;
        },
        getCardNameCatalogSections(vcards) {
          const entries = lib.xd_utils.getCardNameChoiceEntries(vcards);
          const order = [
            ["basic", "基本牌"],
            ["trick_damage", "伤害锦囊"],
            ["trick_utility", "其他普通锦囊"],
            ["trick_delay", "延时锦囊"],
            ["equip_weapon", "武器"],
            ["equip_armor", "防具"],
            ["equip_horse_def", "防御马"],
            ["equip_horse_atk", "进攻马"],
            ["equip_treasure", "宝物牌"],
            ["equip_other", "其他装备"],
            ["other", "其他牌"]
          ];
          return order.map(([key, label]) => ({
            key,
            label,
            entries: entries.filter(item => item.section === key)
          })).filter(section => section.entries.length);
        },
        getCardPublicInfoText(item) {
          if (!item?.name) return "";
          let text = lib.translate[item.name + "_info"];
          if (typeof text !== "string" || !text.trim()) {
            const info = get.info(item.card) || lib.card[item.name];
            text = typeof info?.prompt === "string" ? info.prompt : "";
          }
          if (typeof text !== "string" || !text.trim()) return "将鼠标移到牌面上可查看该牌的公开效果说明。";
          return text.replace(/<br\s*\/?>/gi, "；").replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
        },
        findCardCatalogScrollBox(dialog) {
          if (!dialog) return null;
          // 无名杀 Dialog 真正负责内容滚动的是 content-container。
          // 之前按“谁的 scrollHeight-clientHeight 最大”猜测，会在内容很多时误把最外层 dialog
          // 当成滚动节点；一旦再给它设高度，滚动时就会把整个布枰界面一起卷走。
          // 这里直接优先使用本体明确暴露的 contentContainer / .content-container，
          // 只有极端兼容场景才回退到 content，最后才是 dialog 本身。
          return dialog.contentContainer ||
            dialog.querySelector?.(".content-container") ||
            dialog.content ||
            dialog;
        },
        ensureCardCatalogStyle() {
          if (typeof document === "undefined" || document.getElementById("xd-card-catalog-style")) return;
          const style = document.createElement("style");
          style.id = "xd-card-catalog-style";
          style.textContent = `
            .xd-card-catalog-dialog{width:min(94vw,900px)!important;max-width:min(94vw,900px)!important;max-height:min(86vh,760px)!important;overflow:hidden!important;}
            .xd-card-catalog-dialog .content-container,.xd-card-catalog-dialog .content{width:100%!important;max-width:100%!important;box-sizing:border-box!important;}
            .xd-card-catalog-dialog .xd-card-catalog-scrollbox{overflow-y:scroll!important;overflow-x:hidden!important;overscroll-behavior:contain;scrollbar-width:auto!important;scrollbar-color:rgba(255,255,255,.68) rgba(0,0,0,.25)!important;padding-bottom:6px!important;}
            .xd-card-catalog-dialog .xd-card-catalog-scrollbox::-webkit-scrollbar{width:12px;}
            .xd-card-catalog-dialog .xd-card-catalog-scrollbox::-webkit-scrollbar-thumb{background:rgba(255,255,255,.58);border-radius:8px;border:2px solid rgba(0,0,0,.2);}
            .xd-card-catalog-dialog .xd-card-catalog-scrollbox::-webkit-scrollbar-track{background:rgba(0,0,0,.2);}
            .xd-card-catalog-dialog .xd-card-catalog-intro{width:min(90vw,820px);max-width:min(90vw,820px);margin:4px auto 8px;padding:4px 12px;box-sizing:border-box;text-align:center;line-height:1.48;color:rgba(255,255,255,.98)!important;text-shadow:0 1px 2px rgba(0,0,0,.72);}
            .xd-card-catalog-dialog .xd-card-catalog-preview{width:min(90vw,820px);max-width:min(90vw,820px);min-height:42px;max-height:96px;overflow:auto;margin:4px auto 6px;padding:4px 12px 8px;box-sizing:border-box;text-align:center;line-height:1.42;color:rgba(255,255,255,.98)!important;text-shadow:0 1px 2px rgba(0,0,0,.72);}
            .xd-card-catalog-dialog .xd-card-catalog-hint{width:min(90vw,820px);max-width:min(90vw,820px);margin:2px auto 10px;text-align:center;font-size:13px;line-height:1.35;color:rgba(255,255,255,.94)!important;text-shadow:0 1px 2px rgba(0,0,0,.75);}
            .xd-card-catalog-dialog .xd-card-catalog-section{width:min(90vw,820px);max-width:min(90vw,820px);margin:10px auto 5px;text-align:left;font-weight:600;color:rgba(255,255,255,.98)!important;text-shadow:0 1px 2px rgba(0,0,0,.72);}
            .xd-card-catalog-dialog .buttons{width:min(90vw,820px);max-width:min(90vw,820px);margin-left:auto!important;margin-right:auto!important;}
            .xd-card-catalog-dialog .button.card{cursor:pointer;}
            /* V0.20：继续给列表末尾留更长的“滚动跑道”。
               这不是扩大对话框，也不是重新制造默认死区；它只让最下面几组牌
               在滚动到底时还能继续向上移动到真正可见的区域。 */
            .xd-card-catalog-dialog .xd-card-catalog-tailspacer{height:320px!important;min-height:320px!important;width:100%!important;pointer-events:none!important;}
          `;
          document.head.appendChild(style);
        },
        createCardNameCatalogDialog(title, vcards, options = {}) {
          const u = lib.xd_utils;
          const sections = u.getCardNameCatalogSections(vcards);
          const dialog = ui.create.dialog(title, "forcebutton");
          if (typeof document === "undefined" || !dialog) {
            for (const section of sections) dialog?.add?.([section.entries.map(item => item.info), "vcard"], true);
            return dialog;
          }

          u.ensureCardCatalogStyle();
          dialog.classList?.add("fixed", "xd-card-catalog-dialog");
          const host = dialog.content || dialog;
          const introText = options.intro || "只显示当前时机可以合法使用的牌。选择牌名后，按正常规则选择此牌的目标，再指定一名其他角色提供实体牌；提供者只提供牌，使用者仍是你。";
          const intro = ui.create.div(".text.xd-card-catalog-intro", host, introText);
          const preview = ui.create.div(".text.xd-card-catalog-preview", host, "把鼠标移到牌面上，可以在这里直接查看该牌的公开效果说明。");
          ui.create.div(".text.xd-card-catalog-hint", host, "浏览：鼠标滚轮 / ↑↓ / PgUp·PgDn / Home·End；右侧滚动条可以直接拖动。点击一张牌后，再按原生流程选择目标并确定。");

          for (const section of sections) {
            ui.create.div(".text.xd-card-catalog-section", host, section.label);
            const start = dialog.buttons.length;
            // chooseButton 必须保留本体按钮的原生点击/选中处理。
            // dialog.add 的第二参数 true 会关闭这些按钮的原生 click 绑定；
            // 庄周旧声明器会自己接管点击，所以当时需要 true，【布枰】则不能这样做。
            dialog.add([section.entries.map(item => item.info), "vcard"]);
            const buttons = dialog.buttons.slice(start);
            buttons.forEach((button, index) => {
              const item = section.entries[index];
              if (!item) return;
              const showInfo = () => {
                preview.textContent = "【" + item.label + "】 " + u.getCardPublicInfoText(item);
              };
              button.addEventListener?.("mouseenter", showInfo);
              button.addEventListener?.("focus", showInfo);
              button._customintro = uiintro => {
                uiintro.add("【" + item.label + "】");
                const info = u.getCardPublicInfoText(item);
                if (info) uiintro.add('<div class="text">' + info + '</div>');
              };
              try { lib.setIntro(button); } catch (e) {}
            });
          }

          // 无名杀的 Dialog 底部有一段实际不可用于显示列表内容的区域。
          // V0.17 已经把可视滚动区本身调到合适高度；这里不再碰它。
          // 只在全部牌组之后追加一个不可点击的空白尾段，增加 scrollHeight，
          // 让“防御马 / 进攻马 / 宝物牌”等最后几组可以滚到遮挡区上方完整显示。
          ui.create.div(".xd-card-catalog-tailspacer", host);

          const installScroll = () => {
            const scrollBox = u.findCardCatalogScrollBox(dialog);
            if (!scrollBox) return;
            dialog._xdCardCatalogScrollBox = scrollBox;
            try {
              scrollBox.classList?.add("xd-card-catalog-scrollbox");
              scrollBox.tabIndex = 0;
              const viewportH = window.innerHeight || document.documentElement.clientHeight || 800;
              const maxH = Math.max(280, Math.min(720, viewportH * 0.84));
              scrollBox.style.setProperty("max-height", maxH + "px", "important");
            } catch (e) {}
          };
          // 与庄周旧声明器一致：窗口固定在本体“确认/取消”控制条的正上方，
          // 水平以屏幕中央为锚点。fixed 类和 !important 定位同时避免原生 Dialog 被拖动，
          // 这样点牌时不会误触成拖拽；右侧真正的滚动条仍可正常拖动。
          const placeDialogAboveConfirm = () => {
            try {
              const viewportH = window.innerHeight || document.documentElement.clientHeight || 800;
              const confirmRect = ui.confirm?.getBoundingClientRect?.();
              const confirmTop = confirmRect?.top && confirmRect.top > 0
                ? confirmRect.top
                : viewportH - 90;
              const bottomGap = Math.max(10, viewportH - confirmTop + 10);
              dialog.style.setProperty("position", "fixed", "important");
              dialog.style.setProperty("top", "auto", "important");
              dialog.style.setProperty("bottom", `${bottomGap}px`, "important");
              dialog.style.setProperty("left", "50%", "important");
              dialog.style.setProperty("right", "auto", "important");
              dialog.style.setProperty("transform", "translateX(-50%)", "important");
              dialog.style.setProperty("margin-left", "0", "important");
              dialog.style.setProperty("margin-right", "0", "important");

              const maxDialogH = Math.max(300, Math.min(720, confirmTop - 8));
              dialog.style.setProperty("max-height", `${maxDialogH}px`, "important");
              const scrollBox = dialog._xdCardCatalogScrollBox || u.findCardCatalogScrollBox(dialog);
              if (scrollBox) {
                // V0.20：在 V0.19 的基础上把选牌滚动区缩短 32px。
                // 底部不可点击尾段同时加长，让最后几组牌仍能继续向上滚入可见区域。
                // 底边继续固定在确认/取消上方，滚轮、右侧滚动条和键盘滚动逻辑不变。
                const usable = Math.max(220, maxDialogH - 88);
                scrollBox.style.setProperty("height", `${usable}px`, "important");
                scrollBox.style.setProperty("max-height", `${usable}px`, "important");
              }
            } catch (e) {}
          };
          const wheelHandler = ev => {
            const scrollBox = dialog._xdCardCatalogScrollBox || u.findCardCatalogScrollBox(dialog);
            if (!scrollBox || scrollBox.scrollHeight <= scrollBox.clientHeight + 2) return;
            scrollBox.scrollTop += ev.deltaY;
            ev.preventDefault?.();
            ev.stopPropagation?.();
          };
          const keyHandler = ev => {
            if (!dialog.isConnected) return;
            const scrollBox = dialog._xdCardCatalogScrollBox || u.findCardCatalogScrollBox(dialog);
            if (!scrollBox || scrollBox.scrollHeight <= scrollBox.clientHeight + 2) return;
            let delta = null;
            if (ev.key === "ArrowDown") delta = 80;
            else if (ev.key === "ArrowUp") delta = -80;
            else if (ev.key === "PageDown") delta = Math.max(160, scrollBox.clientHeight * 0.8);
            else if (ev.key === "PageUp") delta = -Math.max(160, scrollBox.clientHeight * 0.8);
            else if (ev.key === "Home") scrollBox.scrollTop = 0;
            else if (ev.key === "End") scrollBox.scrollTop = scrollBox.scrollHeight;
            else return;
            if (delta != null) scrollBox.scrollTop += delta;
            ev.preventDefault?.();
            ev.stopPropagation?.();
          };
          dialog.addEventListener?.("wheel", wheelHandler, { passive: false });
          document.addEventListener("keydown", keyHandler, true);
          const oldClose = dialog.close;
          if (typeof oldClose === "function") {
            dialog.close = function (...args) {
              try { document.removeEventListener("keydown", keyHandler, true); } catch (e) {}
              return oldClose.apply(this, args);
            };
          }
          requestAnimationFrame(() => {
            installScroll();
            requestAnimationFrame(() => {
              installScroll();
              placeDialogAboveConfirm();
            });
          });
          return dialog;
        },
        updateTip(player, skill, text) {
          player.removeTip(skill);
          player.addTip(skill, text);
          player.markSkill(skill);
        },
        // “移出牌”公共底座：实体牌仍放在原生 expansion 区；额外 storage 只记录规则顺序/来源/明暗。
        // 顺序不能依赖 expansion DOM：班超【龙沙】会按“依次移出”的先后顺序进行连续序列匹配。
        movedOutTag: "xd_moved_out_tag",
        ensureMovedOutState(player) {
          if (!player) return { order: [], groups: {}, public: [] };
          if (!Array.isArray(player.storage.xd_moved_out_order)) player.storage.xd_moved_out_order = [];
          if (!player.storage.xd_moved_out_groups || typeof player.storage.xd_moved_out_groups !== "object" || Array.isArray(player.storage.xd_moved_out_groups)) {
            player.storage.xd_moved_out_groups = {};
          }
          if (!Array.isArray(player.storage.xd_moved_out_public)) player.storage.xd_moved_out_public = [];
          return {
            order: player.storage.xd_moved_out_order,
            groups: player.storage.xd_moved_out_groups,
            public: player.storage.xd_moved_out_public
          };
        },
        syncMovedOutState(player) {
          if (!player || typeof player.syncStorage !== "function") return;
          player.syncStorage("xd_moved_out_order");
          player.syncStorage("xd_moved_out_groups");
          player.syncStorage("xd_moved_out_public");
        },
        // 清理已经离开武将牌的旧记录；若遇到旧存档/外部代码直接加入 expansion，
        // 以 v1.11.5.2 expansion 当前显示顺序的逆序作为恢复顺序兜底。
        refreshMovedOutState(player, sync = false) {
          const u = lib.xd_utils, state = u.ensureMovedOutState(player);
          if (!player) return [];
          const current = player.getExpansions(u.movedOutTag);
          const byId = new Map(current.filter(card => card?.cardid).map(card => [card.cardid, card]));
          const oldOrder = state.order.slice();
          const order = oldOrder.filter(id => byId.has(id));
          const known = new Set(order);
          for (const card of current.slice().reverse()) {
            if (card?.cardid && !known.has(card.cardid)) {
              known.add(card.cardid);
              order.push(card.cardid);
            }
          }
          const groups = {};
          for (const id of order) if (state.groups[id] !== undefined) groups[id] = state.groups[id];
          const publicIds = state.public.filter(id => byId.has(id));
          const changed = order.length !== oldOrder.length || order.some((id, i) => id !== oldOrder[i]) ||
            Object.keys(groups).length !== Object.keys(state.groups).length ||
            publicIds.length !== state.public.length || publicIds.some((id, i) => id !== state.public[i]);
          player.storage.xd_moved_out_order = order;
          player.storage.xd_moved_out_groups = groups;
          player.storage.xd_moved_out_public = publicIds;
          if (sync && changed) u.syncMovedOutState(player);
          return order.map(id => byId.get(id)).filter(Boolean);
        },
        getMovedOutCards(player, group) {
          const u = lib.xd_utils, cards = u.refreshMovedOutState(player);
          if (!group) return cards;
          const groups = u.ensureMovedOutState(player).groups;
          return cards.filter(card => groups[card.cardid] === group);
        },
        isMovedOutPublic(player, card) {
          return !!card?.cardid && lib.xd_utils.ensureMovedOutState(player).public.includes(card.cardid);
        },
        async moveOut(player, cards, options = {}) {
          const u = lib.xd_utils;
          if (!player) return [];
          const list = [...new Set((cards ?? []).filter(card => get.itemtype(card) === "card"))];
          const already = new Set(player.getExpansions(u.movedOutTag));
          const moving = list.filter(card => !already.has(card));
          if (!moving.length) return [];
          const params = { cards: moving };
          if (options.source) params.source = options.source;
          else params.source = player;
          if (options.animate !== false) params.animate = options.animate || "gain2";
          const next = player.addToExpansion(params);
          if (!next.gaintag.includes(u.movedOutTag)) next.gaintag.push(u.movedOutTag);
          await next;
          const now = new Set(player.getExpansions(u.movedOutTag));
          const actual = moving.filter(card => now.has(card));
          if (!actual.length) return [];
          const state = u.ensureMovedOutState(player);
          for (const card of actual) {
            const id = card.cardid;
            if (!id) continue;
            if (!state.order.includes(id)) state.order.push(id);
            if (options.group) state.groups[id] = options.group;
            if (options.faceUp && !state.public.includes(id)) state.public.push(id);
            if (options.faceUp && typeof card.addKnower === "function") card.addKnower("everyone");
          }
          u.syncMovedOutState(player);
          return actual;
        },
        forgetMovedOut(player, cards, removeTag = true) {
          const u = lib.xd_utils, state = u.ensureMovedOutState(player);
          const ids = new Set((cards ?? []).map(card => card?.cardid).filter(Boolean));
          if (!ids.size) return;
          player.storage.xd_moved_out_order = state.order.filter(id => !ids.has(id));
          player.storage.xd_moved_out_public = state.public.filter(id => !ids.has(id));
          for (const id of ids) delete state.groups[id];
          player.storage.xd_moved_out_groups = state.groups;
          if (removeTag) {
            for (const card of cards ?? []) {
              if (typeof card?.hasGaintag === "function" && card.hasGaintag(u.movedOutTag)) card.removeGaintag(u.movedOutTag);
            }
          }
          u.syncMovedOutState(player);
        },
        async removeMovedOut(player, cards) {
          const u = lib.xd_utils, current = new Set(u.getMovedOutCards(player));
          const removing = [...new Set((cards ?? []).filter(card => current.has(card)))];
          if (!removing.length) return [];
          await player.loseToDiscardpile(removing);
          u.forgetMovedOut(player, removing);
          return removing;
        },
        updateShownCards(player, force = false) {
          if (force || lib.xd_utils.getShownHandCards(player).length) {
            if (!player.hasSkill("xd_shown_cards_viewer")) player.addSkill("xd_shown_cards_viewer");
            player.markSkill("xd_shown_cards_viewer");
          } else {
            player.unmarkSkill("xd_shown_cards_viewer");
          }
        },
        async revealHandCards(player, cards, tag, message) {
          const current = (cards ?? []).filter(card => player.getCards("h").includes(card) && !lib.xd_utils.isShownHandCard(card, player));
          if (!current.length) return [];
          await player.showCards(current, get.translation(player) + message);
          let shown = false;
          if (typeof player.addShownCards === "function") {
            try {
              await player.addShownCards(current, tag);
              shown = true;
            } catch (e) {}
          }
          if (!shown && typeof player.addGaintag === "function") await player.addGaintag(current, tag);
          lib.xd_utils.updateShownCards(player, true);
          // 明置可发生在两次用牌之间，必须就地记录，不能等下一张牌才观察排列。
          lib.xd_utils.recordCaiyanHandState(player);
          return current;
        },
        // 六合的六位依次为：左1暗/明、左2暗/明、左3暗/明。
        // 八荒的八位对应二进制排列 000..111。满位即完成，不再另存 done。
        caiyanRecords: {
          xd_liuhe: {
            full: 63,
            restore: "xd_shiyuan",
            name: "六合"
          },
          xd_bahuang: {
            full: 255,
            restore: "xd_jieqing",
            name: "八荒"
          }
        },
        getCaiyanHandState(player) {
          const cards = player?.getCards("h");
          return cards?.length === 3 ? cards.map(card => Number(lib.xd_utils.isShownHandCard(card, player))) : null;
        },
        recordCaiyanHandState(player, acquiring) {
          if (!player?.isIn()) return;
          const bits = lib.xd_utils.getCaiyanHandState(player);
          if (!bits) return; // 胡笳补牌/弃牌过程中的非三张中间态不记。
          for (const [id, spec] of Object.entries(lib.xd_utils.caiyanRecords)) {
            if (id !== acquiring && !player.hasSkill(id)) continue;
            const key = id + "_seen",
              before = player.storage[key] ?? 0;
            if (before === spec.full) continue;
            const observed = id === "xd_liuhe" ? bits.reduce((mask, bit, i) => mask | 1 << 2 * i + bit, 0) : 1 << parseInt(bits.join(""), 2);
            const seen = player.storage[key] = before | observed;
            if (seen === before) continue;
            player.markSkill(id);
            if (seen === spec.full) {
              player.popup(spec.name);
              game.log(player, "完成了【" + spec.name + "】的全部记录");
              if (lib.skill[spec.restore] && typeof player.refreshSkill === "function") {
                player.refreshSkill(spec.restore);
                game.log(player, "因【" + spec.name + "】复原了【" + get.translation(spec.restore) + "】");
              }
            }
          }
        },
        caiyanRecordCount(player, id) {
          return (player.storage[id + "_seen"] ?? 0).toString(2).replace(/0/g, "").length;
        },
        caiyanRecordText(player, id) {
          const mask = player.storage[id + "_seen"] ?? 0;
          const check = bit => mask & 1 << bit ? "✓" : "×";
          const lines = id === "xd_liuhe" ? [0, 1, 2].map(i => "左侧第" + get.cnNumber(i + 1, true) + "张：暗" + check(2 * i) + " / 明" + check(2 * i + 1)) : Array.from({
            length: 8
          }, (_, i) => i.toString(2).padStart(3, "0").split("").map(bit => bit === "1" ? "明" : "暗").join("") + " " + check(i));
          const spec = lib.xd_utils.caiyanRecords[id];
          if (mask === spec.full) lines.push("<br>【" + spec.name + "】已完成");
          return lines.join("<br>");
        },
        async resolveCaiyanAwakening(player, id) {
          const shiyuan = id === "xd_shiyuan";
          const gain = shiyuan ? "xd_liuhe" : "xd_bahuang";
          player.awakenSkill(id);
          let chooser = shiyuan ? player.storage.xd_caiyan_last_card_user : player;
          // 沿用原版异常局面的兜底；正常由上次用牌者决定时愿，自己决定竭情。
          if (!chooser || typeof chooser.chooseControl !== "function" || !game.players.concat(game.dead).includes(chooser)) chooser = player;
          if (!player.hasSkill(gain)) {
            const controls = shiyuan ? ["令蔡琰获得【六合】", "令蔡琰失去所有技能并获得【归雁】"] : ["获得【八荒】", "删除【胡笳】的第二行"];
            const result = await chooser.chooseControl(controls).set("prompt", shiyuan ? "【时愿】：请选择" + get.translation(player) + "的命运" : "【竭情】：请选择一项").set("ai", () => shiyuan ? get.attitude(chooser, player) >= 0 ? 0 : 1 : 0).forResult();
            if (result.control !== controls[1]) {
              await player.addSkills(gain);
              return;
            }
          }
          if (shiyuan) {
            // 必须走 changeSkillsBefore，保留胡笳“是否防止失去”的选择权。
            await player.clearSkills(false);
            await player.addSkills("xd_guiyan");
            lib.xd_utils.updateShownCards(player);
          } else {
            player.storage.xd_hujia_line2_deleted = true;
            if (typeof player.syncStorage === "function") player.syncStorage("xd_hujia_line2_deleted");
            game.log(player, "删除了【胡笳】的第二行");
            player.popup("胡笳·改");
          }
        },
        wuqiBailianSentence: "，当你使用牌指定不为其他角色的目标后，将本句移至你另一技能当前项（X为本句触发次数）",
        wuqiPositions: {
          bailian: [null, "【百炼】"],
          congzu_yang: ["xd_congzu", "【从卒·阳】"],
          congzu_yin: ["xd_congzu", "【从卒·阴】"],
          yibian_yang: ["xd_yibian", "【亦变·阳】"],
          yibian_yin: ["xd_yibian", "【亦变·阴】"]
        },
        getWuqiBailianPosition(player) {
          return player?.storage?.xd_bailian_position ?? "bailian";
        },
        getWuqiX(player) {
          const x = player?.storage?.xd_bailian_count;
          return Number.isFinite(x) ? x : 0;
        },
        getWuqiCurrentItem(player, skill) {
          return skill.slice(3) + (player?.storage?.[skill] ? "_yin" : "_yang");
        },
        getWuqiPositionLabel(position) {
          return lib.xd_utils.wuqiPositions[position]?.[1] ?? position;
        },
        getWuqiBailianHost(position) {
          return lib.xd_utils.wuqiPositions[position]?.[0] ?? null;
        },
        isWuqiBailianActive(player) {
          const u = lib.xd_utils,
            position = u.getWuqiBailianPosition(player);
          const host = u.getWuqiBailianHost(position);
          // 阳项没有独立入口；寄宿非当前项时保持封印，不随转换移动。
          return position === "bailian" || !!(host && position.endsWith("_yin") && player?.storage?.[host]);
        },
        isWuqiBailianSatisfied(event, player) {
          if (!event?.card || !player) return false;
          const targets = Array.isArray(event.targets) ? event.targets : [];
          return !!(targets.length && targets.every(target => target === player)) || ["shan", "wuxie"].includes(get.name(event.card, player));
        },
        // 唯一实体材料 + 无转化来源技能 + 原牌名相同，沿用本附件实测判据。
        // 不能用 event.card === event.cards[0]：本体可为直接用牌创建不同的包装对象。
        // 若外部技能构造“同名、单材料、无 skill 标识”的虚拟牌，现有字段不足以区分。
        isWuqiEntityUse(event) {
          if (!event?.card || !Array.isArray(event.cards) || event.cards.length !== 1) return false;
          const physical = event.cards[0];
          return !!physical && get.itemtype(physical) === "card" && !event.skill && !event.card.skill && event.card.name === physical.name;
        },
        getWuqiActionEvents(event) {
          const result = [];
          let current = event;
          let foundAction = false;
          let guard = 0;
          while (current && guard++ < 20) {
            if (current.name === "useCard" || current.name === "respond") {
              result.push(current);
              foundAction = true;
            } else if (foundAction) {
              break;
            }
            let parent = null;
            try {
              parent = typeof current.getParent === "function" ? current.getParent() : current.parent;
            } catch (e) {
              parent = current.parent;
            }
            if (!parent || parent === current) {
              break;
            }
            current = parent;
          }
          if (!result.length && event) {
            result.push(event);
          }
          return result;
        },
        // 同一动作的 useCard/respond 连续祖先共用防重标记；不要越过其他事件串到外层用牌。
        wuqiActionHandled(event, player, key, mark = false) {
          const playerKey = player?.playerid ?? "self";
          const actions = lib.xd_utils.getWuqiActionEvents(event);
          const handled = actions.some(item => !!item?._xd_wuqi_handled?.[playerKey]?.[key]);
          if (mark) for (const item of actions) {
            item._xd_wuqi_handled ??= {};
            item._xd_wuqi_handled[playerKey] ??= {};
            item._xd_wuqi_handled[playerKey][key] = true;
          }
          return handled;
        },
        initWuqi(player) {
          player.storage.xd_bailian_position ??= "bailian";
          player.storage.xd_bailian_count ??= 0;
          lib.xd_utils.updateWuqiTip(player);
        },
        updateWuqiTip(player) {
          if (!player) return;
          const u = lib.xd_utils;
          u.updateTip(player, "xd_bailian", "百炼 当前位于<br>" + u.getWuqiPositionLabel(u.getWuqiBailianPosition(player)) + "<br>X现为" + u.getWuqiX(player));
        },
        getWuqiBailianDestinations(player, position) {
          const u = lib.xd_utils,
            host = u.getWuqiBailianHost(position);
          if (position !== "bailian" && !host) return ["bailian"];
          return (host ? ["bailian"] : []).concat(["xd_congzu", "xd_yibian"].filter(id => id !== host).map(id => u.getWuqiCurrentItem(player, id)));
        },
        wuqiYangEnabled(event, player, id) {
          const u = lib.xd_utils;
          return !player.storage[id] && u.isWuqiEntityUse(event) && lib.skill[id].wuqiTypes.includes(get.type(event.card, null, false)) && !u.wuqiActionHandled(event, player, id);
        },
        async resolveWuqiYang(player, trigger, id) {
          const u = lib.xd_utils;
          if (!u.wuqiYangEnabled(trigger, player, id)) return;
          u.wuqiActionHandled(trigger, player, id, true);
          // 普通牌提前弃置但继续原 useCard/respond；延时锦囊须留下实体进入判定区。
          if (get.type(trigger.card, null, false) !== "delay" && get.position(trigger.cards[0], true) !== "d") {
            await game.cardsDiscard(trigger.cards[0]);
          }
          await player.draw(1);
          const position = u.getWuqiBailianPosition(player);
          if ((position === "bailian" || position === id.slice(3) + "_yang") && u.isWuqiBailianSatisfied(trigger, player)) {
            await u.resolveWuqiBailian(player, trigger, position);
          }
          // 前半句真正执行 → 百炼（如满足）先移动 → 原阳项最后转换。
          // 杀指定别人时不移动百炼，因而可把百炼永久留在已经失活的阳项。
          player.changeZhuanhuanji(id);
          u.updateWuqiTip(player);
        },
        async resolveWuqiBailian(player, event, expectedPosition) {
          const u = lib.xd_utils,
            from = u.getWuqiBailianPosition(player);
          if (expectedPosition !== undefined ? from !== expectedPosition : !u.isWuqiBailianActive(player)) return false;
          if (u.wuqiActionHandled(event, player, "bailian", true)) return false;
          // 保存触发前的阴宿主；句子到达新位置以后，仍转换这个原宿主。
          const yinHost = expectedPosition === undefined && from.endsWith("_yin") ? u.getWuqiBailianHost(from) : null;
          player.storage.xd_bailian_count = u.getWuqiX(player) + 1;
          const destinations = u.getWuqiBailianDestinations(player, from);
          const controls = destinations.map(position => u.getWuqiPositionLabel(position));
          const result = await player.chooseControl(controls).set("prompt", "【百炼】：将本句移至另一技能").set("ai", () => 0).forResult();
          const destination = destinations[Math.max(0, controls.indexOf(result.control))];
          player.storage.xd_bailian_position = destination;
          player.syncStorage("xd_bailian_count");
          player.syncStorage("xd_bailian_position");
          game.log(player, "将“百炼”整句移至", "#g" + u.getWuqiPositionLabel(destination));
          if (yinHost) player.changeZhuanhuanji(yinHost);
          u.updateWuqiTip(player);
          return true;
        },
        wuqiSwitchText(player, id) {
          const u = lib.xd_utils,
            position = u.getWuqiBailianPosition(player);
          const lines = id === "xd_congzu" ? ["阳：你以重铸的方式使用基本牌", "阴：你的攻击频率+X"] : ["阳：你以重铸的方式使用锦囊牌", "阴：你的额定摸牌数+X"];
          return "转换技，锁定技，" + lines.map((line, i) => {
            if (position === id.slice(3) + (i ? "_yin" : "_yang")) line += u.wuqiBailianSentence;
            return i === Number(!!player.storage[id]) ? '<span class="bluetext">' + line + "</span>" : line;
          }).join("；") + "。";
        },
        juemoNames: {
          basic: "基本牌",
          black: "黑色牌",
          damage: "伤害牌",
          shown: "明置牌"
        }
      });
      lib.dynamicTranslate.xd_hujia = function (player) {
        if (player.storage.xd_hujia_line2_deleted) {
          return '锁定技，你的手牌恒为三张。你能防止本技能失去。';
        }
        return '锁定技，你的手牌恒为三张。你能防止本技能失去。<br>你不能改变手牌顺序，使用牌前须明置另一张牌。';
      };
      lib.dynamicTranslate.xd_sijiao = function (player) {
        var s = player.storage.xd_sijiao ?? [0, 1, 2];
        return '锁定技，你使用牌时执行首个可执行项：重铸' + s[0] + '张明置基本牌；明置' + get.cnNumber(s[1]) + '张牌；摸牌至' + get.cnNumber(s[2]) + '张；以上数值+1。';
      };
      lib.dynamicTranslate.xd_juemo = function (player) {
        const items = player.storage.xd_juemo_items ?? ["basic", "black", "damage"];
        const names = lib.xd_utils.juemoNames;
        let text = "当你使用" + items.map(item => names[item]).join("/") + "后，你可以摸一张牌并明置之，令你下次使用牌须满足剩余项";
        if (items.some(item => item !== "shown")) {
          text += "，无剩余项则将一项改为‘明置牌’";
        }
        return text + "。";
      };
      lib.dynamicTranslate.xd_congzu = function (player) {
        return lib.xd_utils.wuqiSwitchText(player, "xd_congzu");
      };
      lib.dynamicTranslate.xd_yibian = function (player) {
        return lib.xd_utils.wuqiSwitchText(player, "xd_yibian");
      };
      lib.dynamicTranslate.xd_bailian = function (player) {
        const position = lib.xd_utils.getWuqiBailianPosition(player);
        const sentence = lib.xd_utils.wuqiBailianSentence;
        return "锁定技" + (position === "bailian" ? sentence + "。" : "。");
      };
      // 【君侧】的武将牌技能文本随当前分组实时变化；只改显示，不另造技能形态。
      lib.dynamicTranslate.xd_junce = function (player) {
        const skill = lib.skill.xd_junce;
        if (!skill || typeof skill.getSides !== "function") return lib.translate.xd_junce_info;
        const sides = skill.getSides(player);
        const format = names => "【" + names.map(name => get.translation(name)).join("/") + "】";
        return "你可以将" + format(sides[0]) + "、" + format(sides[1]) + "当另一侧一张牌使用并将两者移至同侧。任意侧唯一需要使用的牌名改为【无中生有】。";
      };
      lib.dynamicTranslate.xd_qingding = function (player) {
        if (player.storage.xd_qingding_transgressed) {
          return "锁定技，每回合限一次，当你摸牌、回复体力、造成伤害时，若你本轮执行过：仅一项，多执行一次。";
        }
        return "锁定技，每回合限一次，当你摸牌、回复体力、造成伤害时，若你本轮执行过：仅一项，多执行一次；另两项，防止之；所有项，删除本行。";
      };
      lib.dynamicTranslate.xd_xuebian = function (player) {
        const order = Array.isArray(player.storage.xd_xuebian_order)
          ? player.storage.xd_xuebian_order
          : [0, 1, 2];
        const clauses = [
          "本阶段没有角色使用/获得牌",
          "你的体力值/手牌数等于上限",
          "场上没有武器牌/与你势力不同的角色"
        ];
        return "灼然·若" + clauses[order[0]] + "，你可以将你场上一张牌当【无懈可击】/【洞烛先机】使用。<br>"
          + "谬敬·若" + clauses[order[1]] + "，你可以将至少半数手牌当【桃园结义】/【出其不意】使用。<br>"
          + "挽驾·若" + clauses[order[2]] + "，你可以视为使用【借刀杀人】/【远交近攻】。<br>"
          + "结算后，若上文的所有前半句皆不满足，你交换之。";
      };
      // 安装庄周；先安装梦境包装，再叠加李斯的位置选择层。
      installXdZhuangzhou(lib, game, ui, get, ai, _status);

      // 李斯【欺暗】：统一的“按真实位置选择别人牌”层。
      // 必须放在庄周对 Player 方法的兼容包装之后再安装，避免双方覆盖彼此。
      // 只接管本机正在操作的李斯；AI/联机客机保持本体流程，避免把本地 DOM 对话框广播出去。
      {
        const PP = lib.element.Player?.prototype || lib.element.player;
        if (PP && !PP._xd_qian_playerCardPickerInstalled) {
          PP._xd_qian_playerCardPickerInstalled = true;

          const activeLocalLisi = (player, target) =>
            player === game.me && player?.isIn?.() && target?.isIn?.() && player !== target &&
            _status.currentPhase === player && player.hasSkill?.("xd_qian", null, false);

          const closeDialog = dialog => {
            try { dialog?.close?.(); } catch (e) {}
            try { dialog?.delete?.(); } catch (e) {}
          };

          const addZone = (dialog, label, cards, target, hideDark, player, sourceEvent) => {
            if (!cards?.length) return [];
            const host = dialog.content || dialog;
            if (typeof ui.create?.div === "function") {
              ui.create.div(".text.center", host, label);
            }
            const start = dialog.buttons?.length || 0;
            dialog.add([cards, "card"]);
            const buttons = (dialog.buttons || []).slice(start);
            const canSeeAll = !!sourceEvent.visible || !!sourceEvent.visibleMove ||
              !!player.hasSkillTag?.("viewHandcard", null, target, true);

            // 位置选择本身已经稳定后，这里只做布局：1~8张尽量保持同一行，第9张起再换行。
            // 不改按钮大小、不改link、不改本体牌背样式，只放宽这一组按钮的容器。
            const row = buttons[0]?.parentNode;
            if (row?.style) {
              const columns = Math.min(cards.length, 8);
              row.style.display = "grid";
              row.style.gridTemplateColumns = `repeat(${columns}, max-content)`;
              row.style.justifyContent = "center";
              row.style.alignItems = "start";
              row.style.columnGap = "6px";
              row.style.rowGap = "8px";
              row.style.width = "max-content";
              row.style.maxWidth = "calc(100vw - 72px)";
              row.style.marginLeft = "auto";
              row.style.marginRight = "auto";
            }

            buttons.forEach((button, index) => {
              const card = cards[index];
              if (!card) return;
              // link 永远直接绑真实实体牌；不再做“视觉第N张 -> 猜实体第N张”的二次映射。
              button.link = card;
              button._xd_qian_realCard = card;
              button._xd_qian_zone = label;

              if (hideDark && !canSeeAll && !lib.xd_utils.isShownHandCard(card, target)) {
                // 使用本体暗牌类，保留当前主题/美化包自己的原生牌背。
                button.classList?.add("infohidden", "infoflip");
                button.classList?.remove("shown");
                // 暗牌不允许通过悬停说明偷看真实牌面。
                button._customintro = function () {};
              } else {
                button.classList?.remove("infohidden", "infoflip");
              }
            });
            return buttons;
          };

          const qianPlayerCardContent = async function (event) {
            const player = event.player;
            const target = event.target;
            if (!activeLocalLisi(player, target)) {
              // 正常情况下包装器只会在满足条件时替换 content；这是运行时兜底。
              event.result = { bool: false };
              return;
            }

            const qian = lib.skill.xd_qian;
            let hand = target.getCards("h").slice();
            // 选择窗口打开前再次校验真实手牌顺序，防止某个同步/动画刚好在两个触发之间改过 DOM。
            const canonical = qian?.stableOrder ? qian.stableOrder(hand) : hand.slice();
            if (qian?.sameOrder && !qian.sameOrder(hand, canonical)) {
              qian.applyOrder?.(target, canonical);
              hand = target.getCards("h").slice();
            }

            const position = event.position || "he";
            const h = position.includes("h") ? hand : [];
            const e = position.includes("e") ? target.getCards("e").slice() : [];
            const j = position.includes("j") ? target.getCards("j").slice() : [];
            if (!h.length && !e.length && !j.length) {
              event.result = { bool: false, links: [], cards: [], buttons: [] };
              return;
            }

            const title = typeof event.prompt === "string" && event.prompt.length
              ? event.prompt
              : "选择" + get.translation(target) + "的一张牌";
            const dialog = ui.create.dialog(title, "forcebutton");
            dialog.classList?.add("xd-qian-position-dialog");
            // 默认对话框偏窄，会把4张牌都挤成3+1。按手牌数展开，但最多按8列设计；
            // 仍保留视口上限，避免较窄窗口溢出屏幕。
            const handColumns = Math.min(Math.max(h.length, 1), 8);
            const desiredWidth = Math.max(420, handColumns * 102 + 40);
            if (dialog.style) {
              dialog.style.width = desiredWidth + "px";
              dialog.style.maxWidth = "calc(100vw - 48px)";
            }
            if (dialog.content?.style) {
              dialog.content.style.width = "100%";
              dialog.content.style.maxWidth = "100%";
            }

            // 最关键的一点：整副手牌只按 target.getCards('h') 的真实位置添加一次。
            // 已明置/暗置只改变“是否盖住牌面”，绝不改变按钮位置或分组。
            addZone(dialog, "手牌区", h, target, true, player, event);
            addZone(dialog, "装备区", e, target, false, player, event);
            addZone(dialog, "判定区", j, target, false, player, event);

            const next = player.chooseButton(dialog);
            next.set("forced", !!event.forced);
            if (event.selectButton !== undefined) next.set("selectButton", event.selectButton);
            else next.set("selectButton", 1);
            if (typeof event.filterButton === "function") next.set("filterButton", event.filterButton);
            if (typeof event.ai === "function") next.set("ai", event.ai);
            // 【欺明】旧 filterButton 会读取这个自定义字段；一并传给真正的 chooseButton 子事件。
            if (event.xd_qiming_target) next.set("xd_qiming_target", event.xd_qiming_target);

            let result;
            try {
              result = await next.forResult();
            } finally {
              closeDialog(dialog);
            }

            if (!result?.bool || !result.links?.length) {
              event.result = { bool: false, links: [], cards: [], buttons: result?.buttons || [] };
              return;
            }

            // 因为我们的 button.link 就是真实牌，所以这里完全不做位置猜测和 cardid 回查。
            const owned = target.getCards("hej").slice();
            const cards = [...new Set(result.links.filter(card => owned.includes(card)))];
            if (!cards.length) {
              event.result = { bool: false, links: [], cards: [], buttons: result.buttons || [] };
              return;
            }

            event.result = {
              bool: true,
              links: cards,
              cards: cards.slice(),
              buttons: result.buttons || [],
            };

            if (event.name === "gainPlayerCard") {
              await player.gain(cards, target, event.visibleMove ? "give" : "giveAuto");
            } else if (event.name === "discardPlayerCard") {
              await target.discard(cards);
            }
          };

          for (const name of ["choosePlayerCard", "gainPlayerCard", "discardPlayerCard"]) {
            const original = PP[name];
            if (typeof original !== "function" || original._xd_qian_pickerWrapper) continue;
            const wrapped = function (...args) {
              const next = original.apply(this, args);
              try {
                if (next && activeLocalLisi(this, next.target)) {
                  next.setContent(qianPlayerCardContent);
                }
              } catch (e) {}
              return next;
            };
            wrapped._xd_qian_pickerWrapper = true;
            wrapped._xd_qian_raw = original;
            PP[name] = wrapped;
          }
        }
      }

      pengyue.P.install();
    },
    config: {},
    help: {
      "风雨如晦（上）": "<b>《风雨如晦（上）》·玄蝶</b><br>" + "<br>" + "作者／主创：玄蝶<br>" + "开发：ChatGPT、Claude<br>" + "壁纸与界面美术：ChatGPT<br>" + "测试与打磨：Grace_Davis<br>" + "代码贡献：清风（李牧、周公）、蝶设堂（桓温）、无名杀团队<br>" + "<br>" + "代码按其适用的开源许可使用；壁纸与界面美术不随代码授权，转载或二改请注明出处。<br>" + "部分素材来自网络，版权归原作者所有，如有侵权请联系删除。"
    },
    package: {
      character: {
        character: {
          ...Object.fromEntries(Object.entries({          xd_hanzhuo: {
            sex: "male",
            group: "xia",
            hp: 6,
            maxHp: 6,
            skills: ["xd_fenjiao"]
          },
          xd_zhoudan: {
            group: "zhou",
            skills: ["xd_dingding"]
          },
          xd_goujian: {
            group: "chun_qiu",
            hp: 6,
            maxHp: 6,
            skills: ["xd_toulao"]
          },
          xd_limu: {
            group: "zhan_guo",
            skills: ["xd_sijiao"]
          },
          xd_zhuangzhou: {
            sex: "male",
            group: "zhan_guo",
            hp: 3,
            maxHp: 3,
            skills: ["xd_mei", "xd_meng", "xd_xing"]
          },
          xd_lisi: {
            group: "qin",
            hp: 3,
            maxHp: 3,
            skills: ["xd_qian", "xd_qiming"]
          },
          xd_yuji: {
            sex: "female",
            group: "chu",
            hp: 3,
            maxHp: 3,
            skills: ["xd_quxing", "xd_wulan"]
          },
          xd_wangmang: {
            sex: "male",
            group: "xin",
            hp: 4,
            maxHp: 4,
            skills: ["xd_qingding"]
          },
          xd_hanxin: {
            group: "han",
            skills: ["xd_shenji"]
          },
          xd_weiqinghuoqubing: {
            group: "han",
            skills: ["xd_juemo"]
          },
          xd_chenping: {
            group: "han",
            hp: 3,
            maxHp: 3,
            skills: ["xd_jiedu", "xd_youren"]
          },
          xd_wuqi: {
            sex: "male",
            group: "zhan_guo",
            hp: 4,
            maxHp: 4,
            skills: ["xd_congzu", "xd_yibian", "xd_bailian"]
          },
          xd_caiyan: {
            sex: "female",
            group: "han",
            hp: 3,
            maxHp: 3,
            skills: ["xd_hujia", "xd_shiyuan", "xd_jieqing"]
          },
          xd_huanwen: {
            sex: "male",
            group: "jin",
            hp: 4,
            maxHp: 4,
            skills: ["bolyuba", "bolxingjiang"]
          },
          xd_xunguan: {
            sex: "female",
            group: "jin",
            hp: 4,
            maxHp: 4,
            skills: ["xd_yuwei"]
          },
          xd_wangyan: {
            sex: "male",
            group: "jin",
            hp: 3,
            maxHp: 3,
            skills: ["xd_yangkuang", "xd_cihuang", "xd_sanku"]
          },
          xd_zuti: {
            sex: "male",
            group: "jin",
            hp: 4,
            maxHp: 4,
            skills: ["xd_jiji"]
          },
          xd_wenjiao: {
            sex: "male",
            group: "jin",
            hp: 3,
            maxHp: 3,
            skills: ["xd_xuebian"]
          },
          xd_zhuowenjun: {
            sex: "female",
            group: "han",
            hp: 3,
            maxHp: 3,
            skills: ["xd_xiangfu", "xd_yixin"]
          },
          xd_pengyue: {
            sex: "male", group: "han", hp: 4, maxHp: 4,
            skills: ["xd_liebing", "xd_naoji"]
          },
          xd_lvzhi: {
            sex: "female",
            group: "han",
            hp: 4,
            maxHp: 4,
            skills: ["xd_junce"]
          },
          xd_banchao: {
            group: "han",
            skills: ["xd_longsha"]
          },
          xd_xiean: {
            group: "jin",
            hp: 3,
            skills: ["xd_buping", "xd_zhenwu"]
          },
          xd_liuxiu: {
            group: "han",
            skills: ["xd_fuding"]
          },
          xd_suqin: {
            group: "zhan_guo",
            hp: 3,
            maxHp: 3,
            skills: ["xd_jizhi", "xd_hezong"]
          },
          xd_zhangyi: {
            group: "zhan_guo",
            hp: 3,
            maxHp: 3,
            skills: ["xd_lianheng", "xd_haifeng"]
          },
          xd_chentang: {
            group: "han",
            hp: 4,
            maxHp: 4,
            skills: ["xd_jiaobing"]
          },
          xd_quyuan: {
            group: "zhan_guo",
            hp: 3,
            maxHp: 3,
            skills: ["xd_qiusuo", "xd_tianwen"]
          },
          xd_shiyiguang: {
            sex: "female",
            group: "chun_qiu",
            hp: 3,
            maxHp: 3,
            skills: ["xd_lian", "xd_su"]
          },
          xd_kongqiu: {
            sex: "male",
            group: "chun_qiu",
            hp: 3,
            maxHp: 3,
            skills: ["xd_hong", "xd_ren", "xd_hui"]
          },
          xd_wuyuan: {
            sex: "male",
            group: "chun_qiu",
            hp: 4,
            maxHp: 4,
            skills: ["xd_yuanyuan"]
          },
        }).map(([id, data]) => [id, {
          sex: "male",
          hp: 4,
          ...data,
          img: "extension/风雨如晦（上）/image/" + id + ".jpg"
        }])),
          ...legacy.characters
        },
        translate: {
          xd_zhoudan: "周旦",
          xd_hanxin: "韩信",
          xd_limu: "李牧",
          xd_weiqinghuoqubing: "卫青 霍去病",
          xd_chenping: "陈平",
          xd_wuqi: "吴起",
          xd_caiyan: "蔡琰",
          xd_zhuangzhou: "庄周",
          xd_banchao: "班超",
          xd_xiean: "谢安",
          xd_liuxiu: "刘秀",
          xd_lisi: "李斯",
          xd_suqin: "苏秦",
          xd_zhangyi: "张仪",
          xd_chentang: "陈汤",
          xd_quyuan: "屈原",
          xd_goujian: "勾践",
          xd_shiyiguang: "施夷光",
          xd_kongqiu: "孔丘",
          xd_wuyuan: "伍员",
          xd_hanzhuo: "寒浞",
          xd_huanwen:"桓温",
          xd_xunguan: "荀灌",
          xd_wangyan: "王衍",
          xd_zuti: "祖逖",
          xd_wenjiao: "温峤",
          xd_zhuowenjun: "卓文君",
          xd_pengyue: "彭越",
          xd_yuji: "虞姬",
          xd_lvzhi: "吕雉",
          xd_wangmang: "王莽",
          ...legacy.characterTranslate
        },
        characterIntro: {
          xd_zhoudan: "周公吐哺，天下归心。",
          xd_hanxin: "岂知龙战野，终与凤翔空。",
          xd_limu: "却秦守代著威名，大厦全凭一木撑。",
          xd_weiqinghuoqubing: "牙璋辞凤阙，铁骑绕龙城。",
          xd_chenping: "诛吕鬼神动，安刘天地开。",
          xd_wuqi: "吾示子吾用兵也。",
          xd_caiyan: "神何殛我越荒州，处我天南海北头。",
          xd_zhuangzhou: "彼窃钩者诛，窃国者为诸侯。",
          xd_banchao: "不敢望到酒泉郡，但愿生入玉门关。",
          xd_xiean: "雪洗虏尘静，风约楚云留。",
          xd_liuxiu: "顺迅风而纵烈火，晒白日而扫朝云。",
          xd_lisi: "坑灰未冷山东乱，刘项原来不读书。",
          xd_suqin: "使我有雒阳田二顷，岂能佩六国相印？",
          xd_zhangyi: "一怒而诸侯惧，安居而天下熄。",
          xd_chentang: "明犯强汉者，虽远必诛。",
          xd_quyuan: "路漫漫其修远兮，吾将上下而求索。",
          xd_goujian: "勾践饮胆日，吴酒正满杯。",
          xd_shiyiguang: "道是水柔无性气，急声声怒慢声悲。",
          xd_kongqiu: "天不生仲尼，万古如长夜。",
          xd_wuyuan: "一声长在耳，万恨重经心。",
          xd_hanzhuo: "野树滴残龙战血，曦车碾下朝霞屑。",
          xd_huanwen: "既不能流芳后世，亦不足复遗臭万载。",
          xd_xunguan: "借问骁将谁，发覆青虫簪。",
          xd_wangyan: "瑶树忽倾沧海里，醉乡翻在夜台中。",
          xd_zuti: "曾记否，到中流击水，浪遏飞舟。",
          xd_wenjiao: "松浮欲尽不尽云，江动将崩未崩石。",
          xd_zhuowenjun: "愿得一人心，白头不相离。",
          xd_pengyue: "辘轳夜转槽床响，分明蟹筐才脱。",
          xd_yuji: "看花满眼泪，不共楚王言。",
          xd_lvzhi: "儿妇人口不可用，顾君与我何如耳。",
          xd_wangmang: "向使当初身便死，一生真伪复谁知。",
          ...legacy.characterIntro
        },
        characterTitle: {
          xd_zhoudan: "周公",
          xd_hanxin: "兵仙",
          xd_limu: "关山一暮",
          xd_weiqinghuoqubing: "狼胥",
          xd_chenping: "游精杳漠",
          xd_wuqi: "锋推徊变",
          xd_caiyan: "三𡫛",
          xd_zhuangzhou: "不一不也",
          xd_banchao: "定远侯",
          xd_xiean: "江左风流",
          xd_liuxiu: "龙飞白水",
          xd_lisi: "溷鼠",
          xd_suqin: "凤鸣鸷翰",
          xd_zhangyi: "鹗心鹂舌",
          xd_chentang: "西极天马",
          xd_quyuan: "香草冲涛",
          xd_goujian: "卧薪尝胆",
          xd_shiyiguang: "浣溪沙",
          xd_kongqiu: "百世师",
          xd_wuyuan: "鞭墓戮尸",
          xd_hanzhuo: "枭獍",
          xd_huanwen:"游蛟射主",
          xd_xunguan: "斗寇年华",
          xd_wangyan: "玄虚陆沉",
          xd_zuti: "此非恶声",
          xd_wenjiao: "玉镜照水",
          xd_zhuowenjun: "朱弦明镜",
          xd_pengyue: "搔羽听龙",
          xd_yuji: "惊魂美",
          xd_lvzhi: "雌龙",
          xd_wangmang: "假帝巨君",
          ...legacy.characterTitle
        }
      },
      card: {
        card: {},
        translate: {},
        list: []
      },
      skill: {
        skill: {
          ...pengyue.skills,
          ...legacy.skills,
          // 孔丘：弘 / 仁 / 诲
          // UI 后置：本版先把真实【闪电】、伤害/判定、弟子来源与体力槽额度接入原生事件系统。
          xd_kongqiu_engine: {
            charlotte: true,
            popup: false,
            allPlayers() {
              return game.players.concat(game.dead || []);
            },
            findPlayer(id) {
              return lib.skill.xd_kongqiu_engine.allPlayers().find(current => current?.playerid === id) || null;
            },
            isAlive(player) {
              return !!player && player?.isIn?.() && !lib.skill.xd_kongqiu_engine.hongState(player).dead;
            },

            // ---------- 【弘】：唯一实体牌、真 shandian、判定区流转 ----------
            hongState(player) {
              if (!player.storage.xd_hong_state || typeof player.storage.xd_hong_state !== "object") {
                player.storage.xd_hong_state = { card: null, waiting: false, busy: false, dead: false };
              }
              return player.storage.xd_hong_state;
            },
            isHongCard(card, owner) {
              const id = card?.storage?.xd_hong_owner;
              return !!id && (!owner || id === owner.playerid);
            },
            markHongCard(card, owner) {
              if (!card || !owner) return;
              card.storage ||= {};
              card.storage.xd_hong_owner = owner.playerid;
              card.storage.xd_hong = true;
              game.broadcastAll((current, ownerId) => {
                if (!current) return;
                current.storage ||= {};
                current.storage.xd_hong_owner = ownerId;
                current.storage.xd_hong = true;
                try {
                  // 规则身份始终是真 shandian；显示只保留孔丘武将头像。
                  current.setBackground?.("xd_kongqiu", "character");
                  current.classList?.remove?.("fullskin");
                  current.classList?.add?.("fullimage");
                  const hide = ["name", "name2", "info", "suitnum", "range", "gaintag"];
                  for (const key of hide) {
                    if (current.node?.[key]?.style) current.node[key].style.display = "none";
                  }
                } catch (e) {}
              }, card, owner.playerid);
            },
            getHongCard(owner) {
              const state = lib.skill.xd_kongqiu_engine.hongState(owner);
              if (state.card && lib.skill.xd_kongqiu_engine.isHongCard(state.card, owner)) return state.card;
              for (const current of lib.skill.xd_kongqiu_engine.allPlayers()) {
                let cards = [];
                try { cards = current.getCards("hejxs"); } catch (e) {
                  try { cards = current.getCards("hej"); } catch (e2) {}
                }
                const found = cards.find(card => lib.skill.xd_kongqiu_engine.isHongCard(card, owner));
                if (found) return state.card = found;
              }
              for (const zone of [ui.special, ui.discardPile, ui.ordering, ui.cardPile]) {
                const list = zone?.childNodes ? Array.from(zone.childNodes) : [];
                const found = list.find(card => lib.skill.xd_kongqiu_engine.isHongCard(card, owner));
                if (found) return state.card = found;
              }
              return null;
            },
            createHongCard(owner) {
              const state = lib.skill.xd_kongqiu_engine.hongState(owner);
              const old = lib.skill.xd_kongqiu_engine.getHongCard(owner);
              if (old) return old;
              const card = game.createCard("shandian", "none", "none");
              lib.skill.xd_kongqiu_engine.markHongCard(card, owner);
              state.card = card;
              return card;
            },
            hongHolder(owner) {
              const card = lib.skill.xd_kongqiu_engine.getHongCard(owner);
              if (!card) return null;
              return game.players.find(current => {
                try { return current.getCards("j").includes(card); } catch (e) { return false; }
              }) || null;
            },
            seatOrder(owner) {
              const result = [];
              if (!owner) return result;
              let current = owner;
              for (let i = 0; i < game.players.length + 2; i++) {
                if (current?.isIn?.() && !result.includes(current)) result.push(current);
                current = current?.next;
                if (!current || current === owner) break;
              }
              for (const item of game.players) if (!result.includes(item)) result.push(item);
              return result;
            },
            canTakeHong(target, owner, card) {
              if (!target?.isIn?.()) return false;
              try { return !!target.canAddJudge(card, owner); } catch (e) {}
              try { return !!target.canAddJudge("shandian", owner); } catch (e) {}
              try { return !target.hasJudge("shandian"); } catch (e) { return true; }
            },
            findHongTarget(owner, card) {
              return lib.skill.xd_kongqiu_engine.seatOrder(owner)
                .find(target => lib.skill.xd_kongqiu_engine.canTakeHong(target, owner, card)) || null;
            },
            eventInsideJudge(event) {
              let current = event;
              const seen = new Set();
              for (let i = 0; current && i < 18 && !seen.has(current); i++) {
                seen.add(current);
                if (current.name === "judge" || current.name === "phaseJudge") return true;
                current = current.getParent?.() || current.parent;
              }
              return false;
            },
            eventHasHong(event, owner) {
              let current = event;
              const seen = new Set();
              for (let i = 0; current && i < 20 && !seen.has(current); i++) {
                seen.add(current);
                const list = [];
                if (current.card) list.push(current.card);
                if (Array.isArray(current.cards)) list.push(...current.cards);
                if (current.judging) list.push(current.judging);
                for (const item of list) {
                  if (lib.skill.xd_kongqiu_engine.isHongCard(item, owner)) return true;
                  if (Array.isArray(item?.cards) && item.cards.some(card => lib.skill.xd_kongqiu_engine.isHongCard(card, owner))) return true;
                }
                current = current.getParent?.() || current.parent;
              }
              return false;
            },
            async holdHong(owner, card) {
              const state = lib.skill.xd_kongqiu_engine.hongState(owner);
              state.waiting = true;
              if (!card) return;
              try {
                if (get.position(card, true) !== "s") await game.cardsGotoSpecial(card);
              } catch (e) {
                try { await game.cardsGotoSpecial([card]); } catch (e2) {}
              }
              owner.markSkill?.("xd_hong");
            },
            async placeHong(owner, reason, depth = 0) {
              const engine = lib.skill.xd_kongqiu_engine;
              const state = engine.hongState(owner);
              if (!engine.isAlive(owner) || state.dead || state.busy) return false;
              const card = engine.getHongCard(owner) || engine.createHongCard(owner);
              if (!card) return false;
              engine.markHongCard(card, owner);
              if (engine.hongHolder(owner)) {
                state.waiting = false;
                owner.markSkill?.("xd_hong");
                return true;
              }
              const target = engine.findHongTarget(owner, card);
              if (!target) {
                await engine.holdHong(owner, card);
                return false;
              }
              state.busy = true;
              state.waiting = false;
              try {
                await owner.useCard({
                  card,
                  cards: [card],
                  targets: [target],
                  addCount: false,
                  skill: "xd_hong"
                });
              } finally {
                state.busy = false;
              }
              owner.markSkill?.("xd_hong");
              if (engine.hongHolder(owner)) return true;
              // 被无懈等阻止进入判定区，也仍然属于离场；有限重试防止极端无限链。
              if (engine.isAlive(owner) && depth < 6) return engine.placeHong(owner, reason, depth + 1);
              await engine.holdHong(owner, card);
              return false;
            },
            async destroyHong(owner) {
              const state = lib.skill.xd_kongqiu_engine.hongState(owner);
              state.dead = true;
              state.waiting = false;
              state.busy = true;
              const card = lib.skill.xd_kongqiu_engine.getHongCard(owner);
              if (card) {
                try { await game.cardsGotoSpecial(card); } catch (e) {}
                try { game.broadcastAll(current => current?.remove?.(), card); } catch (e) {}
              }
              state.card = null;
              state.busy = false;
              owner.unmarkSkill?.("xd_hong");
            },

            // ---------- 【仁】：判定来源识别与闪电伤害上下文 ----------
            findHongJudgeOwner(event) {
              for (const owner of lib.skill.xd_kongqiu_engine.allPlayers()) {
                if (!owner?.storage?.xd_hong_state) continue;
                if (lib.skill.xd_kongqiu_engine.eventHasHong(event, owner)) return owner;
              }
              return null;
            },
            shandianHit(event) {
              const result = event?.result || {};
              const card = result.card;
              const suit = result.suit || (card ? get.suit(card) : null);
              const number = Number(result.number || (card ? get.number(card) : 0));
              return suit === "spade" && number >= 2 && number <= 9;
            },

            // ---------- 【诲】：槽位、弟子、技能来源 ----------
            huiState(player) {
              let state = player.storage.xd_hui_state;
              if (!state || typeof state !== "object") {
                state = player.storage.xd_hui_state = {
                  ready: false,
                  wasMax: false,
                  classes: {},
                  serial: 0,
                  skillMeta: {},
                  sourcesByOriginal: {},
                  returned: false
                };
              }
              state.classes ||= {};
              state.skillMeta ||= {};
              state.sourcesByOriginal ||= {};
              return state;
            },
            syncHui(player) {
              try { player.syncStorage("xd_hui_state"); } catch (e) {}
              try { player.markSkill("xd_hui"); } catch (e) {}
            },
            isHandMax(player) {
              if (!player?.isIn?.()) return false;
              const mine = player.countCards("h");
              return game.players.every(current => current.countCards("h") <= mine);
            },
            ensureClass(player, slot) {
              const state = lib.skill.xd_kongqiu_engine.huiState(player);
              const key = String(Math.max(1, Math.floor(Number(slot) || 1)));
              state.classes[key] ||= { used: 0, disciples: [] };
              state.classes[key].used = Math.max(0, Math.floor(Number(state.classes[key].used) || 0));
              state.classes[key].disciples ||= [];
              return state.classes[key];
            },
            activeSlot(player, slot) {
              return !!player?.isIn?.() && Number(slot) >= 1 && Number(slot) <= Math.max(0, Number(player.maxHp) || 0);
            },
            activationFields(info) {
              return !!info && !!(info.trigger || info.enable || info.viewAs || info.chooseButton?.backup);
            },
            isPureStateSkill(skill, seen = new Set()) {
              if (!skill || seen.has(skill)) return true;
              seen.add(skill);
              const info = lib.skill[skill];
              if (!info) return false;
              if (lib.skill.xd_kongqiu_engine.activationFields(info)) return false;
              const related = [];
              if (typeof info.group === "string") related.push(info.group);
              else if (Array.isArray(info.group)) related.push(...info.group);
              if (typeof info.global === "string") related.push(info.global);
              else if (Array.isArray(info.global)) related.push(...info.global);
              for (const name of related) {
                const sub = lib.skill[name];
                if (sub?.charlotte || sub?.silent) continue;
                if (!lib.skill.xd_kongqiu_engine.isPureStateSkill(name, seen)) return false;
              }
              if (info.subSkill) {
                for (const sub of Object.values(info.subSkill)) {
                  if (!sub || sub.charlotte || sub.silent) continue;
                  if (lib.skill.xd_kongqiu_engine.activationFields(sub)) return false;
                }
              }
              return true;
            },
            clonePlain(value, seen = new WeakMap()) {
              if (!value || typeof value !== "object") return value;
              if (seen.has(value)) return seen.get(value);
              if (Array.isArray(value)) {
                const result = [];
                seen.set(value, result);
                for (const item of value) result.push(lib.skill.xd_kongqiu_engine.clonePlain(item, seen));
                return result;
              }
              const proto = Object.getPrototypeOf(value);
              if (proto !== Object.prototype && proto !== null) return value;
              const result = {};
              seen.set(value, result);
              for (const [key, item] of Object.entries(value)) result[key] = lib.skill.xd_kongqiu_engine.clonePlain(item, seen);
              return result;
            },
            makeOptional(info) {
              if (!info || typeof info !== "object") return;
              // 原本强制/锁定的“有触发时机”技能，在孔丘处允许拒绝；内部 charlotte helper 不拆出来询问。
              if (info.trigger && !info.charlotte && (info.forced || info.locked || info.juexingji)) {
                info.forced = false;
                info.direct = false;
                info.frequent = false;
                if (info.silent) info.silent = false;
                if (info.popup === false) delete info.popup;
              }
              if (info.subSkill) for (const sub of Object.values(info.subSkill)) lib.skill.xd_kongqiu_engine.makeOptional(sub);
            },
            needsProxyForForced(skill) {
              if (lib.skill.xd_kongqiu_engine.isPureStateSkill(skill)) return false;
              const inspect = info => {
                if (!info || typeof info !== "object") return false;
                if (info.trigger && !info.charlotte && (info.forced || info.locked || info.juexingji)) return true;
                return !!info.subSkill && Object.values(info.subSkill).some(inspect);
              };
              return inspect(lib.skill[skill]);
            },
            rewriteRelated(value, original, alias) {
              if (typeof value === "string") return value.startsWith(original + "_") ? alias + value.slice(original.length) : value;
              if (Array.isArray(value)) return value.map(item => lib.skill.xd_kongqiu_engine.rewriteRelated(item, original, alias));
              return value;
            },
            createProxy(player, disciple, original) {
              const engine = lib.skill.xd_kongqiu_engine;
              const pid = String(player.playerid || "p").replace(/[^a-zA-Z0-9_]/g, "_");
              const sid = String(original).replace(/[^a-zA-Z0-9_]/g, "_");
              const alias = `xd_hui_${pid}_${disciple.id}_${sid}`;
              if (lib.skill[alias]) return alias;
              const info = lib.skill[original];
              if (!info) return original;
              const copy = engine.clonePlain(info);
              if (copy.group) copy.group = engine.rewriteRelated(copy.group, original, alias);
              if (copy.global) copy.global = engine.rewriteRelated(copy.global, original, alias);
              copy.sourceSkill = alias;
              engine.makeOptional(copy);
              lib.skill[alias] = copy;
              lib.translate[alias] = `${get.translation(original)}·${disciple.slot}体力`;
              lib.translate[alias + "_info"] = get.skillInfoTranslation(original, player, false);
              try { game.finishSkill(alias); } catch (e) {
                console.error("[风雨如晦][诲] 动态技能初始化失败", alias, e);
              }
              for (const [name, child] of Object.entries(lib.skill)) {
                if (name.startsWith(alias + "_") && child && typeof child === "object") child.sourceSkill = alias;
              }
              return alias;
            },
            sourceKey(disciple) {
              return `xd_hui_source_${disciple.id}`;
            },
            async attachDisciple(player, disciple) {
              const engine = lib.skill.xd_kongqiu_engine;
              const state = engine.huiState(player);
              const assigned = [];
              for (const original of disciple.skills || []) {
                if (!lib.skill[original]) continue;
                const sources = state.sourcesByOriginal[original] ||= [];
                // 带 mod 的“状态+触发”混合技能（如界【咆哮】）优先保留本体技能：
                // 复制整套技能容易破坏原本的 cardUsable 等规则修改。额度耗尽时再由 skillBlocker
                // 关闭这项额外权限，基础规则（例如每阶段本来可用1次【杀】）不会被取消。
                const info = lib.skill[original];
                const mixedRule = !!info?.mod && !engine.isPureStateSkill(original);
                const proxy = !mixedRule && (engine.needsProxyForForced(original) || sources.length > 0 || player.hasSkill(original, null, false));
                const actual = proxy ? engine.createProxy(player, disciple, original) : original;
                state.skillMeta[actual] = {
                  disciple: disciple.id,
                  character: disciple.character,
                  slot: disciple.slot,
                  original,
                  pure: engine.isPureStateSkill(original)
                };
                sources.push({ disciple: disciple.id, skill: actual, slot: disciple.slot });
                assigned.push(actual);
              }
              disciple.assigned = assigned;
              if (assigned.length) await player.addAdditionalSkills(engine.sourceKey(disciple), assigned);
              engine.syncHui(player);
            },
            resolveHuiMeta(player, skill) {
              const state = lib.skill.xd_kongqiu_engine.huiState(player);
              let current = skill;
              const seen = new Set();
              for (let i = 0; current && i < 16 && !seen.has(current); i++) {
                seen.add(current);
                if (state.skillMeta[current]) return { root: current, meta: state.skillMeta[current] };
                const info = lib.skill[current];
                if (!info?.sourceSkill || info.sourceSkill === current) break;
                current = info.sourceSkill;
              }
              return null;
            },
            canUseHuiSkill(player, skill) {
              const found = lib.skill.xd_kongqiu_engine.resolveHuiMeta(player, skill);
              if (!found) return true;
              const meta = found.meta;
              if (!lib.skill.xd_kongqiu_engine.activeSlot(player, meta.slot)) return false;
              if (meta.pure) return true;
              return lib.skill.xd_kongqiu_engine.ensureClass(player, meta.slot).used < Number(meta.slot);
            },
            consumeHuiSkill(player, skill) {
              const engine = lib.skill.xd_kongqiu_engine;
              const found = engine.resolveHuiMeta(player, skill);
              if (!found || found.meta.pure || !engine.activeSlot(player, found.meta.slot)) return false;
              const cls = engine.ensureClass(player, found.meta.slot);
              if (cls.used >= Number(found.meta.slot)) return false;
              cls.used++;
              engine.syncHui(player);
              return true;
            },
            getCharacterSkills(name) {
              try {
                const list = get.character(name, 3);
                if (Array.isArray(list)) return list.slice();
              } catch (e) {}
              const info = lib.character[name];
              if (Array.isArray(info?.skills)) return info.skills.slice();
              if (Array.isArray(info?.[3])) return info[3].slice();
              return [];
            },
            async recruit(player) {
              const engine = lib.skill.xd_kongqiu_engine;
              if (!player?.isIn?.()) return;
              if (!_status.characterlist) game.initCharacterList();
              if (!Array.isArray(_status.characterlist) || !_status.characterlist.length) return;
              _status.characterlist.randomSort();
              const name = _status.characterlist[0];
              if (!name || !lib.character[name]) return;
              _status.characterlist.remove(name);
              game.log(player, "以【诲】判得了", "#y" + get.translation(name));
              try {
                if (lib.skill.rehuashen?.drawCharacter) lib.skill.rehuashen.drawCharacter(player, [name]);
                else player.popup(get.translation(name));
              } catch (e) { player.popup(get.translation(name)); }
              // 【仁】：武将牌判定后摸一张。
              await player.draw();

              const maxHp = Math.max(0, Math.floor(Number(player.maxHp) || 0));
              if (!player.isIn() || maxHp < 1) {
                _status.characterlist.add(name);
                return;
              }
              const controls = Array.from({ length: maxHp }, (_, i) => `${i + 1}体力`);
              const result = await player.chooseControl(controls)
                .set("prompt", `【诲】：将${get.translation(name)}置于一个体力上限槽位`)
                .set("ai", () => controls[controls.length - 1])
                .forResult();
              let slot = controls.indexOf(result?.control) + 1;
              if (slot < 1 || slot > maxHp) slot = maxHp;
              const state = engine.huiState(player);
              const disciple = {
                id: ++state.serial,
                character: name,
                slot,
                skills: engine.getCharacterSkills(name),
                assigned: []
              };
              engine.ensureClass(player, slot).disciples.push(disciple);
              await engine.attachDisciple(player, disciple);
              game.log(player, "将", "#y" + get.translation(name), "置于了", `#g${slot}体力`, "槽位");
              engine.syncHui(player);
            },
            resetHuiRound(player) {
              const state = lib.skill.xd_kongqiu_engine.huiState(player);
              for (const cls of Object.values(state.classes)) if (cls) cls.used = 0;
              lib.skill.xd_kongqiu_engine.syncHui(player);
            },
            cleanupHui(player) {
              const state = player.storage.xd_hui_state;
              if (!state || state.returned) return;
              state.returned = true;
              if (!_status.characterlist) game.initCharacterList();
              for (const cls of Object.values(state.classes || {})) {
                for (const disciple of cls?.disciples || []) {
                  if (disciple?.character && lib.character[disciple.character]) _status.characterlist.add(disciple.character);
                  try { player.removeAdditionalSkill(lib.skill.xd_kongqiu_engine.sourceKey(disciple)); } catch (e) {}
                }
              }
              try { player.removeSkillBlocker("xd_hui"); } catch (e) {}
            }
          },

          xd_hong: {
            locked: true,
            forced: true,
            mark: true,
            marktext: "弘",
            intro: {
              content(storage, player) {
                const engine = lib.skill.xd_kongqiu_engine;
                const holder = engine.hongHolder(player);
                if (holder) return `孔丘牌正作为【闪电】位于${get.translation(holder)}的判定区。`;
                if (engine.hongState(player).waiting) return "当前无合法【闪电】落点，孔丘牌正在等待归位。";
                return "孔丘牌正在流转。";
              }
            },
            init(player) {
              lib.skill.xd_kongqiu_engine.hongState(player);
            },
            trigger: { global: "phaseBefore", player: "enterGame" },
            filter(event, player) {
              if (lib.skill.xd_kongqiu_engine.getHongCard(player)) return false;
              return event.name !== "phase" || game.phaseNumber === 0;
            },
            async content(event, trigger, player) {
              lib.skill.xd_kongqiu_engine.createHongCard(player);
              await lib.skill.xd_kongqiu_engine.placeHong(player, "登场");
            },
            group: ["xd_hong_watch", "xd_hong_phasejudge", "xd_hong_retry", "xd_hong_die"],
            subSkill: {
              watch: {
                charlotte: true,
                forced: true,
                popup: false,
                lastDo: true,
                trigger: { global: ["gainAfter", "loseAfter", "loseAsyncAfter", "cardsDiscardAfter", "addJudgeAfter", "addToExpansionAfter", "equipAfter"] },
                filter(event, player) {
                  const engine = lib.skill.xd_kongqiu_engine, state = engine.hongState(player);
                  if (!engine.isAlive(player) || state.dead || state.busy || state.waiting) return false;
                  if (!engine.getHongCard(player) || engine.hongHolder(player)) return false;
                  // 正常闪电判定的中间移动交回原生事件链，避免与 addJudgeNext 抢牌。
                  return !engine.eventInsideJudge(event);
                },
                async content(event, trigger, player) {
                  await lib.skill.xd_kongqiu_engine.placeHong(player, "离场");
                }
              },
              phasejudge: {
                charlotte: true,
                forced: true,
                popup: false,
                lastDo: true,
                trigger: { global: "phaseJudgeEnd" },
                filter(event, player) {
                  const engine = lib.skill.xd_kongqiu_engine, state = engine.hongState(player);
                  return engine.isAlive(player) && !state.dead && !state.busy && !!engine.getHongCard(player) && !engine.hongHolder(player);
                },
                async content(event, trigger, player) {
                  await lib.skill.xd_kongqiu_engine.placeHong(player, "判定后离场");
                }
              },
              retry: {
                charlotte: true,
                forced: true,
                popup: false,
                lastDo: true,
                trigger: { global: ["gainAfter", "loseAfter", "loseAsyncAfter", "cardsDiscardAfter", "addJudgeAfter", "phaseJudgeEnd", "dieAfter"] },
                filter(event, player) {
                  const engine = lib.skill.xd_kongqiu_engine, state = engine.hongState(player);
                  if (!engine.isAlive(player) || state.dead || state.busy || !state.waiting) return false;
                  const card = engine.getHongCard(player);
                  return !!card && !!engine.findHongTarget(player, card);
                },
                async content(event, trigger, player) {
                  await lib.skill.xd_kongqiu_engine.placeHong(player, "归位");
                }
              },
              die: {
                charlotte: true,
                forced: true,
                popup: false,
                forceDie: true,
                firstDo: true,
                trigger: { player: "dieBegin" },
                async content(event, trigger, player) {
                  await lib.skill.xd_kongqiu_engine.destroyHong(player);
                }
              }
            }
          },

          xd_ren: {
            locked: true,
            forced: true,
            group: ["xd_ren_damage", "xd_ren_judge", "xd_ren_clear"],
            subSkill: {
              damage: {
                charlotte: true,
                forced: true,
                popup: false,
                firstDo: true,
                priority: 100000,
                trigger: { global: "damageBegin4" },
                filter(event, player) {
                  if (!event?.player || !event.num || event._xd_ren_replaced) return false;
                  if (event.source === player) return true;
                  const pending = event.player.storage?.xd_hong_damage_pending;
                  return event.card?.name === "shandian" && Array.isArray(pending) && pending.includes(player.playerid);
                },
                async content(event, trigger, player) {
                  const num = Math.max(0, Number(trigger.num) || 0);
                  trigger._xd_ren_replaced = true;
                  const pending = trigger.player.storage?.xd_hong_damage_pending;
                  if (Array.isArray(pending)) pending.remove(player.playerid);
                  trigger.cancel();
                  if (num && trigger.player?.isIn?.()) await trigger.player.draw(num);
                }
              },
              judge: {
                charlotte: true,
                forced: true,
                popup: false,
                trigger: { global: "judgeEnd" },
                filter(event, player) {
                  if (event._xd_ren_kongqiu?.includes?.(player.playerid)) return false;
                  if (event.player === player) return true;
                  return lib.skill.xd_kongqiu_engine.findHongJudgeOwner(event) === player;
                },
                async content(event, trigger, player) {
                  trigger._xd_ren_kongqiu ||= [];
                  trigger._xd_ren_kongqiu.add(player.playerid);
                  const engine = lib.skill.xd_kongqiu_engine;
                  if (engine.findHongJudgeOwner(trigger) === player && engine.shandianHit(trigger)) {
                    trigger.player.storage.xd_hong_damage_pending ||= [];
                    trigger.player.storage.xd_hong_damage_pending.add(player.playerid);
                  }
                  await player.draw();
                }
              },
              clear: {
                charlotte: true,
                forced: true,
                popup: false,
                lastDo: true,
                trigger: { global: "phaseJudgeEnd" },
                content() {
                  for (const current of game.players.concat(game.dead || [])) {
                    if (Array.isArray(current.storage?.xd_hong_damage_pending)) current.storage.xd_hong_damage_pending.length = 0;
                  }
                }
              }
            }
          },

          xd_hui: {
            locked: true,
            mark: true,
            marktext: "诲",
            init(player) {
              lib.skill.xd_kongqiu_engine.huiState(player);
              try { player.addSkillBlocker("xd_hui"); } catch (e) {}
            },
            skillBlocker(skill, player) {
              const engine = lib.skill.xd_kongqiu_engine;
              const found = engine.resolveHuiMeta(player, skill);
              return !!found && !engine.canUseHuiSkill(player, skill);
            },
            intro: {
              markcount(storage, player) {
                const state = lib.skill.xd_kongqiu_engine.huiState(player);
                return Object.values(state.classes).reduce((sum, cls) => sum + (cls?.disciples?.length || 0), 0);
              },
              content(storage, player) {
                const engine = lib.skill.xd_kongqiu_engine, state = engine.huiState(player);
                const slots = Object.keys(state.classes).map(Number).sort((a, b) => a - b);
                if (!slots.length) return "尚无弟子。";
                return slots.map(slot => {
                  const cls = state.classes[String(slot)], active = engine.activeSlot(player, slot);
                  const names = (cls.disciples || []).map(item => get.translation(item.character)).join("、") || "无";
                  return `${slot}体力：${active ? `${cls.used}/${slot}` : "休眠"}；弟子：${names}`;
                }).join("<br>");
              }
            },
            group: ["xd_hui_boot", "xd_hui_watch", "xd_hui_round", "xd_hui_count", "xd_hui_die"],
            onremove(player) {
              lib.skill.xd_kongqiu_engine.cleanupHui(player);
              delete player.storage.xd_hui_state;
            },
            subSkill: {
              boot: {
                charlotte: true,
                forced: true,
                popup: false,
                firstDo: true,
                trigger: { global: "phaseBefore", player: "enterGame" },
                filter(event, player) {
                  const state = lib.skill.xd_kongqiu_engine.huiState(player);
                  if (state.ready) return false;
                  return event.name !== "phase" || game.phaseNumber === 0;
                },
                content(event, trigger, player) {
                  const engine = lib.skill.xd_kongqiu_engine, state = engine.huiState(player);
                  state.wasMax = engine.isHandMax(player);
                  state.ready = true;
                  engine.syncHui(player);
                }
              },
              watch: {
                charlotte: true,
                forced: true,
                popup: false,
                lastDo: true,
                trigger: { global: ["gainAfter", "loseAfter", "loseAsyncAfter", "cardsDiscardAfter", "addToExpansionAfter", "equipAfter", "addJudgeAfter"] },
                filter(event, player) {
                  const state = lib.skill.xd_kongqiu_engine.huiState(player);
                  return player.isIn() && state.ready;
                },
                async content(event, trigger, player) {
                  const engine = lib.skill.xd_kongqiu_engine, state = engine.huiState(player);
                  const now = engine.isHandMax(player), recruit = !state.wasMax && now;
                  // 先写回，再招生；招生会因【仁】摸牌，不能让嵌套 gain 再次招生。
                  state.wasMax = now;
                  if (recruit) {
                    player.logSkill("xd_hui");
                    await engine.recruit(player);
                  } else engine.syncHui(player);
                }
              },
              round: {
                charlotte: true,
                forced: true,
                popup: false,
                trigger: { global: "roundStart" },
                content(event, trigger, player) {
                  lib.skill.xd_kongqiu_engine.resetHuiRound(player);
                }
              },
              count: {
                charlotte: true,
                forced: true,
                popup: false,
                firstDo: true,
                priority: 100000,
                trigger: { player: "logSkillBegin" },
                filter(event, player) {
                  const skill = event.skill || event.sourceSkill;
                  if (!skill) return false;
                  const found = lib.skill.xd_kongqiu_engine.resolveHuiMeta(player, skill);
                  if (!found || found.meta.pure) return false;
                  const info = lib.skill[skill];
                  return !info?.charlotte && !info?.silent;
                },
                content(event, trigger, player) {
                  lib.skill.xd_kongqiu_engine.consumeHuiSkill(player, trigger.skill || trigger.sourceSkill);
                }
              },
              die: {
                charlotte: true,
                forced: true,
                popup: false,
                forceDie: true,
                trigger: { player: "dieBegin" },
                content(event, trigger, player) {
                  lib.skill.xd_kongqiu_engine.cleanupHui(player);
                }
              }
            }
          },
          // 伍员：冤冤
          // 每个真正拥有【冤冤】的角色维护自己独立的“冤冤牌 + 永久指定名单”。
          // 临时获得【冤冤】后形成的牌和名单不会因临时技能消失而删除；再次获得时继续沿用。
          xd_yuanyuan_engine: {
            charlotte: true,
            popup: false,
            allPlayers() {
              return game.players.concat(game.dead || []);
            },
            state(player) {
              let state = player.storage.xd_yuanyuan_state;
              if (!state || typeof state !== "object" || Array.isArray(state)) {
                state = player.storage.xd_yuanyuan_state = { targets: [], revengeTurn: null };
              }
              if (!Array.isArray(state.targets)) state.targets = [];
              state.targets = [...new Set(state.targets.filter(id => typeof id === "string" && id))];
              if (typeof state.revengeTurn !== "string") state.revengeTurn = null;
              return state;
            },
            sync(player) {
              if (typeof player.syncStorage === "function") player.syncStorage("xd_yuanyuan_state");
              if (player.hasSkill?.("xd_yuanyuan", null, false)) player.markSkill?.("xd_yuanyuan");
            },
            findPlayer(id) {
              return lib.skill.xd_yuanyuan_engine.allPlayers().find(current => current?.playerid === id) || null;
            },
            targets(player, inGameOnly = true) {
              const state = lib.skill.xd_yuanyuan_engine.state(player);
              const list = state.targets.map(id => lib.skill.xd_yuanyuan_engine.findPlayer(id)).filter(Boolean);
              return inGameOnly ? list.filter(target => target?.isIn?.()) : list;
            },
            moved(player) {
              return lib.xd_utils.getMovedOutCards(player, "xd_yuanyuan");
            },
            cardType(card, owner) {
              if (!card) return null;
              let type = null;
              try { type = get.type2(card, owner); } catch (e) {}
              if (type === "basic" || type === "trick" || type === "equip") return type;
              try { type = get.type(card, null, false); } catch (e) {}
              if (type === "delay") type = "trick";
              return type === "basic" || type === "trick" || type === "equip" ? type : null;
            },
            sameTypeMoved(player, card, cardOwner) {
              const type = lib.skill.xd_yuanyuan_engine.cardType(card, cardOwner);
              if (!type) return [];
              return lib.skill.xd_yuanyuan_engine.moved(player).filter(current =>
                lib.skill.xd_yuanyuan_engine.cardType(current, player) === type
              );
            },
            turnKey() {
              const current = _status.currentPhase;
              if (!current) return null;
              return String(Number(game.phaseNumber) || 0) + ":" + (current.playerid || "none");
            },
            revengeActive(player) {
              const key = lib.skill.xd_yuanyuan_engine.turnKey();
              return !!key && lib.skill.xd_yuanyuan_engine.state(player).revengeTurn === key;
            },
            grantKey(owner) {
              return "xd_yuanyuan_grant_" + owner.playerid;
            },
            addGrant(owner, target) {
              if (!target) return;
              const key = lib.skill.xd_yuanyuan_engine.grantKey(owner);
              if (typeof target.addAdditionalSkill === "function") {
                target.addAdditionalSkill(key, "xd_yuanyuan");
                return;
              }
              // 旧环境兜底：逐来源记录，只有确由本兜底加入的【冤冤】才会在最后一个来源消失时移除。
              target.storage.xd_yuanyuan_fallback_sources ??= [];
              if (!target.storage.xd_yuanyuan_fallback_sources.includes(key)) target.storage.xd_yuanyuan_fallback_sources.push(key);
              if (!target.hasSkill("xd_yuanyuan", null, false)) {
                target.storage.xd_yuanyuan_fallback_added = true;
                target.addSkill("xd_yuanyuan");
              }
            },
            removeGrant(owner, target) {
              if (!target) return;
              const key = lib.skill.xd_yuanyuan_engine.grantKey(owner);
              if (typeof target.removeAdditionalSkill === "function") {
                target.removeAdditionalSkill(key);
                return;
              }
              const list = target.storage.xd_yuanyuan_fallback_sources;
              if (!Array.isArray(list)) return;
              target.storage.xd_yuanyuan_fallback_sources = list.filter(item => item !== key);
              if (!target.storage.xd_yuanyuan_fallback_sources.length && target.storage.xd_yuanyuan_fallback_added) {
                delete target.storage.xd_yuanyuan_fallback_added;
                if (target.hasSkill("xd_yuanyuan", null, false)) target.removeSkill("xd_yuanyuan");
              }
            },
            clearGrants(owner) {
              for (const target of lib.skill.xd_yuanyuan_engine.allPlayers()) {
                lib.skill.xd_yuanyuan_engine.removeGrant(owner, target);
              }
            },
            grantAll(owner) {
              if (!lib.skill.xd_yuanyuan_engine.revengeActive(owner)) return;
              for (const target of lib.skill.xd_yuanyuan_engine.targets(owner, true)) {
                lib.skill.xd_yuanyuan_engine.addGrant(owner, target);
              }
            },
            addTargets(owner, targets) {
              const state = lib.skill.xd_yuanyuan_engine.state(owner);
              let changed = false;
              for (const target of targets || []) {
                if (!target || target === owner || !target.playerid) continue;
                if (!state.targets.includes(target.playerid)) {
                  state.targets.push(target.playerid);
                  changed = true;
                }
              }
              if (changed) lib.skill.xd_yuanyuan_engine.sync(owner);
              // “其”按当前永久名单动态判断：本回合已清空后新指定的人也立即进入效果。
              if (lib.skill.xd_yuanyuan_engine.revengeActive(owner)) {
                for (const target of targets || []) if (target?.isIn?.() && target !== owner) {
                  lib.skill.xd_yuanyuan_engine.addGrant(owner, target);
                }
              }
            },
            sortTargets(targets) {
              const list = [...new Set((targets || []).filter(target => target?.isIn?.()))];
              const start = _status.currentPhase;
              if (typeof list.sortBySeat === "function") {
                list.sortBySeat(start || undefined);
                return list;
              }
              // 旧环境兜底：沿原生 next 座次链，从当前回合角色开始排列。
              if (!start) return list;
              const result = [];
              let current = start;
              for (let i = 0; current && i < game.players.length + 2; i++) {
                if (list.includes(current) && !result.includes(current)) result.push(current);
                current = current.next;
                if (!current || current === start) break;
              }
              for (const target of list) if (!result.includes(target)) result.push(target);
              return result;
            },
            async drawCircle(owner) {
              const drawers = [owner, ...lib.skill.xd_yuanyuan_engine.targets(owner, true)]
                .filter((target, index, array) => target?.isIn?.() && array.indexOf(target) === index);
              if (!drawers.length) return;
              if (typeof game.asyncDraw === "function") await game.asyncDraw(drawers, 1);
              else for (const target of drawers) await target.draw(1);
            },
            activateRevenge(owner) {
              const key = lib.skill.xd_yuanyuan_engine.turnKey();
              if (!key) return;
              const state = lib.skill.xd_yuanyuan_engine.state(owner);
              if (state.revengeTurn && state.revengeTurn !== key) lib.skill.xd_yuanyuan_engine.clearGrants(owner);
              state.revengeTurn = key;
              lib.skill.xd_yuanyuan_engine.sync(owner);
              if (!owner.hasSkill?.("xd_yuanyuan_revenge", null, false)) owner.addSkill("xd_yuanyuan_revenge");
              lib.skill.xd_yuanyuan_engine.grantAll(owner);
            }
          },

          xd_yuanyuan: {
            locked: true,
            forced: true,
            mark: true,
            marktext: "冤",
            init(player) {
              lib.skill.xd_yuanyuan_engine.state(player);
              player.markSkill?.("xd_yuanyuan");
            },
            intro: {
              markcount(storage, player) {
                return lib.skill.xd_yuanyuan_engine.moved(player).length;
              },
              mark(dialog, content, player) {
                const engine = lib.skill.xd_yuanyuan_engine;
                const cards = engine.moved(player);
                const targets = engine.targets(player, false);
                if (cards.length) {
                  dialog.addText("冤冤牌");
                  dialog.addAuto(cards);
                } else dialog.addText("当前没有冤冤牌");
                dialog.addText("以此法指定过：" + (targets.length ? targets.map(target => get.translation(target)).join("、") : "无"));
                if (engine.revengeActive(player)) dialog.addText("本回合已移去所有冤冤牌：上述角色视为拥有【冤冤】，且你对其造成的伤害改为其体力值。");
              }
            },
            group: ["xd_yuanyuan_discard", "xd_yuanyuan_use"],
            subSkill: {
              discard: {
                charlotte: true,
                forced: true,
                popup: false,
                trigger: { player: "phaseDiscardBegin" },
                filter(event, player) {
                  return player.countCards("h") > 0;
                },
                async content(event, trigger, player) {
                  const engine = lib.skill.xd_yuanyuan_engine, u = lib.xd_utils;
                  const result = await player.chooseCard({
                    position: "h",
                    selectCard: [1, Infinity],
                    forced: true,
                    prompt: "【冤冤】：移出至少一张手牌"
                  }).set("ai", card => 7 - get.value(card, player)).forResult();
                  if (!result?.bool || !result.cards?.length) return;

                  player.logSkill("xd_yuanyuan");
                  const moved = await u.moveOut(player, result.cards, {
                    group: "xd_yuanyuan",
                    faceUp: true,
                    source: player,
                    animate: "gain2"
                  });
                  if (!moved.length) return;
                  player.markSkill?.("xd_yuanyuan");

                  // 作者明确允许指定0人；forced + [0, Infinity] 保留原生“空选后确定”。
                  const chosen = await player.chooseTarget({
                    prompt: "【冤冤】：选择任意名其他角色（可以不选）；其依原生座次顺序依次视为对你使用【杀】",
                    forced: true,
                    selectTarget: [0, Infinity],
                    filterTarget(card, player, target) {
                      return target !== player && target.isIn();
                    },
                    ai(target) {
                      const player = get.player();
                      return get.attitude(player, target) > 0 ? 1 : -1;
                    }
                  }).forResult();
                  const targets = [...new Set((chosen?.targets || []).filter(target => target?.isIn?.() && target !== player))];

                  // 一次选择完成即都属于“以此法指定过”；之后每张【杀】各自完整结算。
                  engine.addTargets(player, targets);
                  const ordered = engine.sortTargets(targets);
                  for (const target of ordered) {
                    if (!player.isIn()) break;
                    if (!target?.isIn?.()) continue;
                    const useEvent = target.useCard({
                      card: { name: "sha", isCard: true },
                      cards: [],
                      targets: [player],
                      addCount: false,
                      skill: "xd_yuanyuan"
                    });
                    if (useEvent) await useEvent;
                  }
                }
              },
              use: {
                charlotte: true,
                forced: true,
                popup: false,
                trigger: { global: "useCardAfter" },
                filter(event, player) {
                  if (!player?.isIn?.() || !event?.player || !event.card) return false;
                  const engine = lib.skill.xd_yuanyuan_engine;
                  const state = engine.state(player);
                  if (event.player !== player && !state.targets.includes(event.player.playerid)) return false;
                  return engine.sameTypeMoved(player, event.card, event.player).length > 0;
                },
                async content(event, trigger, player) {
                  const engine = lib.skill.xd_yuanyuan_engine, u = lib.xd_utils;
                  let candidates = engine.sameTypeMoved(player, trigger.card, trigger.player);
                  if (!candidates.length) return;

                  let card = candidates[0];
                  if (candidates.length > 1) {
                    const result = await player.chooseButton([
                      "###冤冤###移去一张与" + get.translation(trigger.card) + "同类的冤冤牌",
                      [candidates, "card"]
                    ], true).set("ai", button => 7 - get.value(button.link, player)).forResult();
                    if (!result?.bool || !result.links?.length) return;
                    card = result.links[0];
                  }

                  player.logSkill("xd_yuanyuan", trigger.player === player ? undefined : trigger.player);
                  const before = engine.moved(player).length;
                  const removed = await u.removeMovedOut(player, [card]);
                  if (!removed.length) return;
                  player.markSkill?.("xd_yuanyuan");
                  const emptied = before > 0 && engine.moved(player).length === 0;

                  await engine.drawCircle(player);
                  if (emptied) engine.activateRevenge(player);
                }
              }
            }
          },

          // “移去所有牌”产生的回合内持续效果独立保存。
          // 这样即便【冤冤】本体因其他效果暂时消失，已经成立的伤害改写仍可持续到本回合结束。
          xd_yuanyuan_revenge: {
            charlotte: true,
            popup: false,
            forced: true,
            forceDie: true,
            trigger: { global: "phaseAfter" },
            filter(event, player) {
              return !!lib.skill.xd_yuanyuan_engine.state(player).revengeTurn;
            },
            content(event, trigger, player) {
              player.removeSkill("xd_yuanyuan_revenge");
            },
            onremove(player) {
              const engine = lib.skill.xd_yuanyuan_engine;
              engine.clearGrants(player);
              const state = engine.state(player);
              state.revengeTurn = null;
              engine.sync(player);
            },
            group: "xd_yuanyuan_revenge_damage",
            subSkill: {
              damage: {
                charlotte: true,
                forced: true,
                popup: false,
                firstDo: true,
                priority: 100000,
                trigger: { source: "damageBegin1" },
                filter(event, player) {
                  if (!event?.player || !lib.skill.xd_yuanyuan_engine.revengeActive(player)) return false;
                  return lib.skill.xd_yuanyuan_engine.state(player).targets.includes(event.player.playerid);
                },
                content(event, trigger, player) {
                  const num = Math.max(0, Number(trigger.player.hp) || 0);
                  if (num <= 0) trigger.cancel();
                  else trigger.num = num;
                }
              }
            }
          },

          // 陈汤：矫兵
          // X始终是“当前移出牌中，点数严格大于当前手牌数的牌数”。
          // 每次使用存在实体材料的牌前，只做无副作用预演：
          // X0（使用前）→ 假设全部实体材料移出后得X1 → 以X1为固定目标摸牌 → 得X2。
          // 仅当X2<=X0时才真正执行；过程中X是否曾增加不影响最终判断。
          xd_jiaobing: {
            locked: true,
            forced: true,
            // 【矫兵】的移出信息公开，但UI不展示具体牌面：
            // 任意玩家点开标记时，只看到这些移出牌的点数，并按从小到大排列。
            mark: true,
            marktext: "兵",
            intro: {
              markcount(storage, player) {
                return lib.xd_utils.getMovedOutCards(player).length;
              },
              mark(dialog, content, player) {
                const cards = lib.xd_utils.getMovedOutCards(player);
                const h = player.countCards("h");
                const x = lib.skill.xd_jiaobing.getX(player, cards, h);
                dialog.addText("手牌数为" + h + "，当前X为" + x);
                if (!cards.length) {
                  dialog.addText("当前没有移出牌");
                  return;
                }
                const numbers = cards.map(card => Number(get.number(card, player)))
                  .filter(number => Number.isFinite(number))
                  .sort((a, b) => a - b);
                dialog.addText("移出牌点数：" + numbers.join("、"));
              }
            },
            trigger: {
              player: "useCardBefore"
            },
            getMaterials(event) {
              if (!Array.isArray(event?.cards)) return [];
              return [...new Set(event.cards.filter(card => get.itemtype(card) === "card"))];
            },
            getX(player, cards, handCount) {
              const moved = cards || lib.xd_utils.getMovedOutCards(player);
              const h = handCount === undefined ? player.countCards("h") : handCount;
              return moved.reduce((sum, card) => {
                const number = Number(get.number(card, player));
                return sum + (Number.isFinite(number) && number > h ? 1 : 0);
              }, 0);
            },
            preview(event, player) {
              const skill = lib.skill.xd_jiaobing, u = lib.xd_utils;
              const materials = skill.getMaterials(event);
              if (!materials.length) return null;

              const moved0 = u.getMovedOutCards(player);
              const movedSet = new Set(moved0);
              const handCards = new Set(player.getCards("h"));
              const h0 = player.countCards("h");
              const x0 = skill.getX(player, moved0, h0);

              // 预演“以移出方式使用”：所有尚未移出的实体材料都加入移出区；
              // 只有当前真实位于手牌区的材料会令手牌数下降。
              const newlyMoved = materials.filter(card => !movedSet.has(card));
              const handSpent = newlyMoved.filter(card => handCards.has(card)).length;
              const h1 = Math.max(0, h0 - handSpent);
              const moved1 = moved0.concat(newlyMoved);
              const x1 = skill.getX(player, moved1, h1);

              // “摸牌至X张”中的X锁定为移出完成后得到的X1；
              // 摸到目标以后再以新的手牌数重新计算X2。抽到什么牌不影响X。
              const h2 = Math.max(h1, x1);
              const x2 = skill.getX(player, moved1, h2);
              return { materials, newlyMoved, h0, x0, h1, x1, h2, x2, qualifies: x2 <= x0 };
            },
            filter(event, player) {
              const result = lib.skill.xd_jiaobing.preview(event, player);
              return !!result?.qualifies;
            },
            async content(event, trigger, player) {
              const skill = lib.skill.xd_jiaobing, u = lib.xd_utils;
              // filter与content之间原则上没有会改变状态的窗口，但这里仍重新预演，
              // 避免依赖缓存或旧快照。
              const plan = skill.preview(trigger, player);
              if (!plan?.qualifies) return;

              const before = new Set(u.getMovedOutCards(player));
              const needMove = plan.materials.filter(card => !before.has(card));
              if (needMove.length) {
                await u.moveOut(player, needMove, {
                  group: "xd_jiaobing",
                  faceUp: true,
                  source: player,
                  animate: "gain2"
                });
                const now = new Set(u.getMovedOutCards(player));
                // 正常引擎流程中实体材料应全部成功移出。若外部效果令其中任一张
                // 无法进入移出区，则不能继续按已经失真的预演目标补牌。
                if (needMove.some(card => !now.has(card))) return;
                player.markSkill("xd_jiaobing");
              }

              trigger._xd_jiaobing_materials = plan.materials.slice();
              trigger._xd_jiaobing_x0 = plan.x0;
              trigger._xd_jiaobing_x1 = plan.x1;
              trigger._xd_jiaobing_x2 = plan.x2;

              // 基本牌/普通锦囊：实体材料留在移出区，只让虚拟的“这张牌”继续结算。
              // 装备牌/延时锦囊：仍把实体材料交给原生useCard，使其结算后进入装备区/判定区；
              // 它们在此刻（摸牌后、牌生效前）仍属于移出牌，故已经完整参与X2预测。
              const type = get.type(trigger.card, null, false);
              if (type !== "equip" && type !== "delay") {
                const materials = new Set(plan.materials);
                trigger.cards = (trigger.cards || []).filter(card => !materials.has(card));
                if (Array.isArray(trigger.card?.cards)) {
                  trigger.card.cards = trigger.card.cards.filter(card => !materials.has(card));
                }
              }

              await player.drawTo(plan.x1);
            },
            group: ["xd_jiaobing_cleanup"],
            subSkill: {
              cleanup: {
                charlotte: true,
                trigger: {
                  player: "useCardAfter"
                },
                forced: true,
                popup: false,
                filter(event) {
                  return Array.isArray(event._xd_jiaobing_materials) && event._xd_jiaobing_materials.length > 0;
                },
                content(event, trigger, player) {
                  const u = lib.xd_utils;
                  const expansions = new Set(player.getExpansions(u.movedOutTag));
                  const left = trigger._xd_jiaobing_materials.filter(card => !expansions.has(card));
                  // 装备/延时锦囊生效后会离开武将牌；只清除已经离开的旧移出标签/顺序记录。
                  // 仍留在扩展区的普通牌继续作为陈汤的移出牌参与以后X的计算。
                  if (left.length) {
                    u.forgetMovedOut(player, left);
                    player.markSkill("xd_jiaobing");
                  }
                }
              }
            }
          },
          // 苏秦：辑志 / 合纵
          // 【辑志】作为全局出牌阶段入口：使用者选择至少两张“当前合法目标角色数”相同的牌，
          // 交给任一拥有【辑志】的其他角色，再由该角色授予使用者一个尚未拥有的【辑志】/【合纵】。
          xd_jizhi: {
            global: "xd_jizhi_trade",
            getRuleCard(card, player) {
              if (!card) return null;
              const data = {
                name: get.name(card, player) || card.name,
                nature: get.nature(card, player) || card.nature,
                suit: get.suit(card, player),
                number: get.number(card, player),
                isCard: true
              };
              try {
                return get.autoViewAs(data, [card]);
              } catch (e) {
                return data;
              }
            },
            // “合法目标数”严格按作者定义：当前可以被使用者选为此牌目标的角色数。
            // 这里不是一张牌“一次能选几个目标”：普通【杀】一次通常只选一人，
            // 但若此刻有7名角色都分别可成为该【杀】的合法目标，则其合法目标数就是7。
            // 【闪】、【无懈可击】在没有角色目标可选时为0；装备、延时锦囊等则按当前真实目标合法性计算。
            countSelectablePlayers(ruleCard, player) {
              const name = get.name(ruleCard, player) || ruleCard?.name;
              // 【闪】和【无懈可击】没有“可被使用者选择为此牌目标的角色”，故合法目标数为0。
              // 不把“响应的牌/事件”误算成角色目标。
              if (name === "shan" || name === "wuxie") return 0;
              let count = 0;
              const info = get.info(ruleCard, false) || {};
              for (const target of game.players) {
                if (!target?.isIn?.()) continue;
                let ok = false;
                try {
                  // 第三参数 undefined：保留距离限制；第四参数 false：忽略既往使用次数，
                  // 只问“若使用这张牌，这名角色当前能否成为目标”。
                  ok = !!player.canUse(ruleCard, target, undefined, false);
                } catch (e) {
                  try {
                    if (typeof info.filterTarget === "function" && !info.filterTarget(ruleCard, player, target)) continue;
                    if (typeof lib.filter.targetEnabled2 === "function" && !lib.filter.targetEnabled2(ruleCard, player, target)) continue;
                    if (typeof lib.filter.targetInRange === "function" && !lib.filter.targetInRange(ruleCard, player, target)) continue;
                    ok = true;
                  } catch (e2) {}
                }
                if (ok) count++;
              }
              return count;
            },
            getLegalTargetCount(card, player) {
              const ruleCard = lib.skill.xd_jizhi.getRuleCard(card, player);
              if (!ruleCard) return null;
              return lib.skill.xd_jizhi.countSelectablePlayers(ruleCard, player);
            },
            sameLegalTargetCount(cards, player) {
              if (!Array.isArray(cards) || !cards.length) return false;
              let expected = null;
              for (const card of cards) {
                const count = lib.skill.xd_jizhi.getLegalTargetCount(card, player);
                if (!Number.isFinite(count)) return false;
                if (expected === null) expected = count;
                else if (count !== expected) return false;
              }
              return true;
            },
            missingSkills(player) {
              return ["xd_jizhi", "xd_hezong"].filter(skill => !player.hasSkill(skill));
            }
          },
          xd_jizhi_trade: {
            sourceSkill: "xd_jizhi",
            enable: "phaseUse",
            // 多名角色可以同时拥有【辑志】。这里保留一个统一的原生技能入口，
            // 由“选择哪名【辑志】持有者为目标”来区分发动的是谁的【辑志】。
            // “其他角色出牌阶段限一次”按每一名【辑志】持有者分别计算，不能用 usable:1
            // （否则场上有多个【辑志】时，发动第一个人的技能就会把其余人的入口一起锁死）。
            position: "he",
            selectCard: [2, Infinity],
            selectTarget: 1,
            discard: false,
            lose: false,
            delay: false,
            complexCard: true,
            targetKey(target) {
              return target?.playerid || null;
            },
            hasUsedOn(player, target) {
              const key = lib.skill.xd_jizhi_trade.targetKey(target);
              if (!key) return false;
              return (player.storage.xd_jizhi_trade_used || []).includes(key);
            },
            markUsedOn(player, target) {
              const key = lib.skill.xd_jizhi_trade.targetKey(target);
              if (!key) return;
              if (!Array.isArray(player.storage.xd_jizhi_trade_used)) player.storage.xd_jizhi_trade_used = [];
              if (!player.storage.xd_jizhi_trade_used.includes(key)) player.storage.xd_jizhi_trade_used.push(key);
              if (typeof player.syncStorage === "function") player.syncStorage("xd_jizhi_trade_used");
            },
            filter(event, player) {
              if (!lib.skill.xd_jizhi.missingSkills(player).length) return false;
              if (!game.hasPlayer(target => target !== player && target.isIn() && target.hasSkill("xd_jizhi") && !lib.skill.xd_jizhi_trade.hasUsedOn(player, target))) return false;
              const cards = player.getCards("he");
              const skill = lib.skill.xd_jizhi;
              for (let i = 0; i < cards.length; i++) {
                const a = skill.getLegalTargetCount(cards[i], player);
                for (let j = i + 1; j < cards.length; j++) {
                  if (a === skill.getLegalTargetCount(cards[j], player)) return true;
                }
              }
              return false;
            },
            filterCard(card, player) {
              const skill = lib.skill.xd_jizhi;
              const selected = ui.selected.cards || [];
              const count = skill.getLegalTargetCount(card, player);
              if (!Number.isFinite(count)) return false;
              if (selected.length) {
                return selected.every(other => skill.getLegalTargetCount(other, player) === count);
              }
              // 第一张就排除“没有任何第二张与它合法目标数相同”的死路。
              return player.getCards("he").some(other => other !== card && skill.getLegalTargetCount(other, player) === count);
            },
            filterTarget(card, player, target) {
              return target !== player
                && target.isIn()
                && target.hasSkill("xd_jizhi")
                && !lib.skill.xd_jizhi_trade.hasUsedOn(player, target)
                && lib.skill.xd_jizhi.missingSkills(player).length > 0;
            },
            targetprompt: "发动此人的【辑志】",
            prompt: "辑志：选择要发动哪名角色的【辑志】，并交给其至少两张合法目标数相同的牌",
            check(card) {
              const player = get.player();
              if (ui.selected.cards.length >= 2) return 0;
              return 7 - get.value(card, player);
            },
            async content(event, trigger, player) {
              const target = event.target;
              const cards = [...new Set((event.cards || []).filter(card => player.getCards("he").includes(card)))];
              if (!target || cards.length < 2) return;

              // 最终再复核一次：所有交出的牌的“当前可选合法目标角色数”必须完全相同。
              if (!lib.skill.xd_jizhi.sameLegalTargetCount(cards, player)) return;
              if (!target.hasSkill("xd_jizhi") || lib.skill.xd_jizhi_trade.hasUsedOn(player, target)) return;

              // 这次发动额度属于“这名【辑志】持有者”，而不是全场共用一次。
              // 先登记本阶段已经对该持有者发动过，随后再进行交牌与授技。
              lib.skill.xd_jizhi_trade.markUsedOn(player, target);
              await target.gain(cards, player, "giveAuto");

              const available = lib.skill.xd_jizhi.missingSkills(player);
              if (!available.length) return;
              let gain = available[0];
              if (available.length > 1) {
                const labels = available.map(skill => get.translation(skill));
                const result = await target.chooseControl(labels)
                  .set("prompt", "【辑志】：令" + get.translation(player) + "获得一个技能")
                  .set("ai", () => {
                    // 默认优先让尚无扩散能力的角色获得【辑志】；仅是 AI 选择，不影响玩家自由决定。
                    return labels.indexOf("辑志");
                  }).forResult();
                const index = Math.max(0, labels.indexOf(result.control));
                gain = available[index] || available[0];
              }
              if (player.hasSkill(gain)) return;
              await player.addSkills(gain);
              game.log(target, "令", player, "获得了", "#g【" + get.translation(gain) + "】");

              // 【辑志】有一个特殊的时序边界：本次交牌本身发生在技能完整结算之前，
              // 因而不能靠“当前已经进入 useSkill 历史”提前把这一批牌算进去。
              // 只有整次【辑志】完成后，才把这次发动写入“同名技能发动史”。
              //
              // 这里需要同时记录两个人：
              // 1. 交牌者 player：他实际选择并发动了这名持有者的【辑志】；
              // 2. 【辑志】持有者 target：本次被发动的正是他的【辑志】。
              // 这样二者从本次结算结束后才构成“发动过同名技能”的关系；
              // 刚刚作为发动成本交出去的那批牌不会反过来触发【合纵·阴】。
              lib.skill.xd_hezong.markJizhiCompleted(player);
              lib.skill.xd_hezong.recordSemanticSkillUse(player, "xd_jizhi");
              lib.skill.xd_hezong.recordSemanticSkillUse(target, "xd_jizhi");
            },
            group: "xd_jizhi_trade_clear",
            ai: {
              order: 6.5,
              result: {
                player(player) {
                  return lib.skill.xd_jizhi.missingSkills(player).length ? 1 : 0;
                },
                target(player, target) {
                  return get.attitude(player, target) > 0 ? 1 : 0;
                }
              }
            }
          },
          xd_jizhi_trade_clear: {
            charlotte: true,
            forced: true,
            popup: false,
            trigger: { player: ["phaseUseAfter", "phaseAfter"] },
            filter(event, player) {
              return Array.isArray(player.storage.xd_jizhi_trade_used) && player.storage.xd_jizhi_trade_used.length > 0;
            },
            content(event, trigger, player) {
              delete player.storage.xd_jizhi_trade_used;
              if (typeof player.syncStorage === "function") player.syncStorage("xd_jizhi_trade_used");
            }
          },
          xd_hezong: {
            // 原生 chooseToUse 入口：出牌阶段可主动“印”即时牌，回合外也可响应【闪】/【无懈可击】等。
            enable: "chooseToUse",
            zhuanhuanji: true,
            mark: true,
            // 使用无名杀转化技惯用的太极标记；changeZhuanhuanji 会随阴/阳状态刷新其朝向。
            marktext: "☯",
            init(player, skill) {
              if (typeof player.storage[skill] !== "boolean") player.storage[skill] = false; // false=阳，true=阴
            },
            getLegalVCards(event, player) {
              if (!event || event.responded || typeof event.filterCard !== "function") return [];
              return get.inpileVCardList(info => {
                const card = get.autoViewAs({
                  name: info[2],
                  nature: info[3],
                  isCard: true
                }, "unsure");
                const type = get.type(card, null, false);
                if (type !== "basic" && type !== "trick") return false;
                try {
                  return event.filterCard(card, player, event);
                } catch (e) {
                  return false;
                }
              });
            },
            getLostCards(event, target) {
              const cards = [];
              try {
                if (typeof event.getl === "function") {
                  const info = event.getl(target) || {};
                  for (const key of ["cards2", "cards", "hs", "es", "js", "ss", "xs"]) {
                    if (Array.isArray(info[key])) cards.push(...info[key]);
                  }
                }
              } catch (e) {}
              if (event.player === target && Array.isArray(event.cards)) cards.push(...event.cards);
              return [...new Set(cards.filter(card => get.itemtype(card) === "card"))];
            },
            // 把 useSkill 历史里的内部子技能/backup 还原到真正归属的主技能。
            // 这样“仁德_backup”“某技能_effect”等不会被误认为另一个技能。
            resolveSourceSkill(skill) {
              let current = skill;
              const seen = new Set();
              while (current && !seen.has(current)) {
                seen.add(current);
                const info = lib.skill[current];
                if (!info?.sourceSkill || info.sourceSkill === current) break;
                current = info.sourceSkill;
              }
              return current || skill;
            },
            // “同名技能”按玩家实际看到的技能名比较；若没有翻译则退回规范化后的技能 ID。
            // 因此不同内部 ID 只要真正显示为同一个技能名，也仍然属于“同名”。
            getSkillName(skill) {
              const source = lib.skill.xd_hezong.resolveSourceSkill(skill);
              let name = lib.translate[source];
              if (typeof name !== "string" || !name.trim()) {
                try { name = get.translation(source); } catch (e) {}
              }
              if (typeof name !== "string" || !name.trim()) return source || skill || "";
              return name.replace(/<[^>]*>/g, "").trim();
            },
            // “发动过同名技能”读取真实 useSkill 历史，并把 backup/subSkill 归并回表面主技能。
            // 锁定技/强制技只要真的发生过一次技能结算也算“发动过”；【连横】正是这种情况。
            // 仅排除 charlotte/silent 等纯内部状态技能，以及没有表面翻译名的内部 helper。
            isRealSkillUse(historyEvent) {
              const raw = historyEvent?.skill || historyEvent?.sourceSkill;
              if (!raw) return false;
              const rawInfo = lib.skill[raw] || {};
              const source = lib.skill.xd_hezong.resolveSourceSkill(raw);
              const sourceInfo = lib.skill[source] || {};
              if (rawInfo.charlotte || rawInfo.silent) return false;
              if (sourceInfo.charlotte || sourceInfo.silent) return false;
              const translated = lib.translate[source];
              if (typeof translated !== "string" || !translated.trim()) return false;
              return true;
            },
            // 某些“技能属于甲、但实际由乙触发并执行”的效果（例如【连横·阴】）
            // 本体的 useSkill 历史未必会把乙记作发动者，因此额外留下语义层面的真实发动记录。
            recordSemanticSkillUse(player, skill) {
              if (!player || !skill) return;
              const name = lib.skill.xd_hezong.getSkillName(skill);
              if (!name) return;
              const list = Array.isArray(player.storage.xd_semantic_skill_uses) ? player.storage.xd_semantic_skill_uses : [];
              if (!list.includes(name)) list.push(name);
              player.storage.xd_semantic_skill_uses = list;
              if (typeof player.syncStorage === "function") player.syncStorage("xd_semantic_skill_uses");
            },
            markJizhiCompleted(player) {
              if (!player) return;
              player.storage.xd_jizhi_completed = (player.storage.xd_jizhi_completed || 0) + 1;
              if (typeof player.syncStorage === "function") player.syncStorage("xd_jizhi_completed");
            },
            getActivatedSkillNames(player) {
              const names = new Set();
              if (!player) return names;
              for (const name of (player.storage.xd_semantic_skill_uses || [])) {
                if (typeof name === "string" && name) names.add(name);
              }
              if (typeof player.getAllHistory !== "function") return names;
              let history = [];
              try { history = player.getAllHistory("useSkill") || []; } catch (e) {}
              for (const evt of history) {
                if (!lib.skill.xd_hezong.isRealSkillUse(evt)) continue;
                const raw = evt.skill || evt.sourceSkill;
                const source = lib.skill.xd_hezong.resolveSourceSkill(raw);
                // 【辑志】第一次发动时，useSkill 记录会早于“交牌”结算进入历史。
                // 必须等整次【辑志】完成，才把这一次算作“已经发动过”，否则首批交出的牌会反触发【合纵·阴】。
                if (source === "xd_jizhi" && !(player.storage.xd_jizhi_completed > 0)) continue;
                const name = lib.skill.xd_hezong.getSkillName(source);
                if (name) names.add(name);
              }
              return names;
            },
            sharedActivatedSkill(player, target) {
              if (!player || !target || player === target) return null;
              const mine = lib.skill.xd_hezong.getActivatedSkillNames(player);
              if (!mine.size) return null;
              const theirs = lib.skill.xd_hezong.getActivatedSkillNames(target);
              for (const name of mine) {
                if (theirs.has(name)) return name;
              }
              return null;
            },
            matchesLast(card, owner, last) {
              if (!card || !last?.name) return false;
              // 阳项没有实体牌可供他人“失去”，故此处按牌名对应；属性【杀】仍属于【杀】这一牌名。
              return (get.name(card, owner) || card.name) === last.name;
            },
            matchingLosers(event, player) {
              const last = player.storage.xd_hezong_last;
              if (!last?.name) return [];
              const all = game.players.concat(game.dead || []);
              return all.filter(target => {
                if (!target || target === player) return false;
                if (!lib.skill.xd_hezong.sharedActivatedSkill(player, target)) return false;
                return lib.skill.xd_hezong.getLostCards(event, target)
                  .some(card => lib.skill.xd_hezong.matchesLast(card, target, last));
              });
            },
            filter(event, player) {
              if (player.storage.xd_hezong) return false;
              return lib.skill.xd_hezong.getLegalVCards(event, player).length > 0;
            },
            chooseButton: {
              dialog(event, player) {
                const list = lib.skill.xd_hezong.getLegalVCards(event, player);
                return ui.create.dialog("合纵：视为使用一张即时牌", [list, "vcard"]);
              },
              filter(button, player) {
                const event = _status.event.getParent();
                if (!event || typeof event.filterCard !== "function" || !Array.isArray(button.link)) return false;
                const card = get.autoViewAs({
                  name: button.link[2],
                  nature: button.link[3],
                  isCard: true
                }, "unsure");
                const type = get.type(card, null, false);
                if (type !== "basic" && type !== "trick") return false;
                try {
                  return event.filterCard(card, player, event);
                } catch (e) {
                  return false;
                }
              },
              check(button) {
                const player = get.player();
                return player.getUseValue({ name: button.link[2], nature: button.link[3], isCard: true });
              },
              backup(links) {
                const link = links[0] || [];
                return {
                  filterCard: () => false,
                  selectCard: -1,
                  popname: true,
                  sourceSkill: "xd_hezong",
                  viewAs: {
                    name: link[2] || "sha",
                    nature: link[3],
                    isCard: true
                  }
                };
              },
              prompt(links) {
                const link = links[0] || [];
                return "发动【合纵】，视为使用" + get.translation({ name: link[2] || "sha", nature: link[3], isCard: true });
              }
            },
            hiddenCard(player, name) {
              // 【无懈可击】的询问与【闪】/【桃】等不同：本体会先在外层 _wuxie 流程里
              // 判断玩家“有没有可能提供无懈”，随后才创建 chooseToUse。若这里强制要求
              // 当前事件已经是 chooseToUse，手里没有实体【无懈】时，本体会直接跳过该玩家，
              // 导致【合纵】根本拿不到发动窗口。因此阳状态下要提前声明可提供【无懈】。
              if (player.storage.xd_hezong) return false;
              if (name === "wuxie") return true;
              const event = _status.event;
              if (!event || event.name !== "chooseToUse") return false;
              return lib.skill.xd_hezong.getLegalVCards(event, player).some(info => info[2] === name);
            },
            intro: {
              content(storage, player) {
                const yin = !!player.storage.xd_hezong;
                const last = player.storage.xd_hezong_last;
                let text = "当前项：" + (yin ? "阴" : "阳");
                if (last?.name) {
                  text += "<br>上次阳项使用：" + get.translation({ name: last.name, nature: last.nature, isCard: true });
                }
                return text;
              }
            },
            group: ["xd_hezong_record", "xd_hezong_yin"],
            subSkill: {
              backup: {},
              record: {
                charlotte: true,
                forced: true,
                popup: false,
                firstDo: true,
                trigger: { player: ["useCard1", "respond"] },
                filter(event, player) {
                  if (player.storage.xd_hezong) return false;
                  const skill = event.skill || event.sourceSkill;
                  return skill === "xd_hezong_backup" || skill === "xd_hezong";
                },
                content(event, trigger, player) {
                  const name = get.name(trigger.card, player) || trigger.card?.name;
                  if (!name) return;
                  player.storage.xd_hezong_last = {
                    name,
                    nature: get.nature(trigger.card, player) || trigger.card?.nature || null
                  };
                  if (typeof player.syncStorage === "function") {
                    player.syncStorage("xd_hezong_last");
                  }
                  player.changeZhuanhuanji("xd_hezong");
                  player.markSkill("xd_hezong");
                }
              },
              yin: {
                charlotte: true,
                forced: true,
                popup: false,
                trigger: { global: ["loseAfter", "loseAsyncAfter"] },
                filter(event, player) {
                  return !!player.storage.xd_hezong && lib.skill.xd_hezong.matchingLosers(event, player).length > 0;
                },
                async content(event, trigger, player) {
                  const losers = lib.skill.xd_hezong.matchingLosers(trigger, player);
                  if (!losers.length) return;
                  player.logSkill("xd_hezong", losers[0]);
                  const drawers = game.filterPlayer(target => target.hasSkill("xd_jizhi"));
                  if (drawers.length) {
                    if (typeof game.asyncDraw === "function") {
                      await game.asyncDraw(drawers, 1);
                    } else {
                      for (const target of drawers) await target.draw(1);
                    }
                  }
                  if (player.hasSkill("xd_hezong")) {
                    player.changeZhuanhuanji("xd_hezong");
                    player.markSkill("xd_hezong");
                  }
                }
              }
            },
            ai: {
              order: 8,
              respondSha: true,
              respondShan: true,
              save: true,
              skillTagFilter(player, tag) {
                if (player.storage.xd_hezong) return false;
                const event = _status.event;
                if (!event || event.name !== "chooseToUse") return false;
                const need = tag === "respondSha" ? "sha" : tag === "respondShan" ? "shan" : null;
                const list = lib.skill.xd_hezong.getLegalVCards(event, player);
                if (need) return list.some(info => info[2] === need);
                if (tag === "save") return list.some(info => ["tao", "jiu"].includes(info[2]));
                return list.length > 0;
              },
              result: { player: 1 }
            }
          },
          // 张仪：连横 / 海锋
          // 【连横】复用吴起已经实机验证过的“以重铸方式使用实体牌”底层：
          // 普通实体牌先弃置再摸1，装备/延时锦囊先摸1并保留实体牌继续正常区域结算；纯虚拟牌不触发。
          xd_lianheng: {
            locked: true,
            forced: true,
            zhuanhuanji: true,
            firstDo: true,
            mark: true,
            marktext: "☯",
            init(player, skill) {
              if (typeof player.storage[skill] !== "boolean") player.storage[skill] = false; // false=阳，true=阴
              if (!Array.isArray(player.storage.xd_lianheng_targets)) player.storage.xd_lianheng_targets = [];
            },
            onremove(player) {
              delete player.storage.xd_lianheng;
              delete player.storage.xd_lianheng_targets;
              if (typeof player.syncStorage === "function") player.syncStorage("xd_lianheng_targets");
            },
            getTargetIds(player) {
              return Array.isArray(player?.storage?.xd_lianheng_targets) ? player.storage.xd_lianheng_targets : [];
            },
            setTargets(player, targets) {
              const ids = [...new Set((targets || []).filter(target => target?.playerid).map(target => target.playerid))];
              player.storage.xd_lianheng_targets = ids;
              if (typeof player.syncStorage === "function") player.syncStorage("xd_lianheng_targets");
            },
            getTargets(player) {
              const ids = new Set(lib.skill.xd_lianheng.getTargetIds(player));
              return game.players.filter(target => ids.has(target.playerid));
            },
            isEntityAction(event) {
              // 吴起已经验证过：唯一实体材料、无转化来源技能、原牌名相同，才属于真正实体牌使用/响应。
              return lib.xd_utils.isWuqiEntityUse(event);
            },
            actorWasYinTarget(event, owner) {
              const actor = event?.player;
              if (!actor || !owner) return false;
              // 阴项检查的必须是“当前这张牌使用之前”的上次用牌目标。
              // 上次目标只在张仪本次 useCard 完整结束后更新，因此这里直接读取存档即可。
              return lib.skill.xd_lianheng.getTargetIds(owner).includes(actor.playerid);
            },
            trigger: { global: "useCard" },
            filter(event, player) {
              if (!lib.skill.xd_lianheng.isEntityAction(event)) return false;
              if (lib.xd_utils.wuqiActionHandled(event, player, "lianheng")) return false;
              if (!player.storage.xd_lianheng) return event.player === player; // 阳：你
              return lib.skill.xd_lianheng.actorWasYinTarget(event, player);   // 阴：你上次使用牌的目标
            },
            async content(event, trigger, player) {
              const actor = trigger.player;
              if (!actor) return;
              lib.xd_utils.wuqiActionHandled(trigger, player, "lianheng", true);
              const physical = trigger.cards?.[0];
              if (!physical) return;

              const type = get.type(trigger.card, null, false);
              // 与吴起一致：普通实体牌先入弃牌堆再继续原 useCard；
              // 装备牌、延时锦囊必须留下实体，先摸牌后再正常进入装备区/判定区。
              if (type !== "equip" && type !== "delay" && get.position(physical, true) !== "d") {
                await game.cardsDiscard(physical);
              }
              await actor.draw(1);

              // 【连横·阴】的技能实际属于张仪，但规则语义上是“目标发动了同名技能”。
              // 显式把真正执行“重铸方式使用牌”的角色记为这次【连横】的发动者。
              lib.skill.xd_hezong.recordSemanticSkillUse(actor, "xd_lianheng");
              if (actor === player) player.logSkill("xd_lianheng");
              else player.logSkill("xd_lianheng", actor);

              player.changeZhuanhuanji("xd_lianheng");
              player.markSkill("xd_lianheng");
            },
            intro: {
              nocount: true,
              content(storage, player) {
                if (!player.storage.xd_lianheng) return "当前项：阳<br>你以重铸方式使用实体牌；虚拟牌不触发。";
                const targets = lib.skill.xd_lianheng.getTargets(player);
                return "当前项：阴<br>你上次使用牌的目标：" + (targets.length ? targets.map(get.translation).join("、") : "无") + "<br>这些角色以重铸方式使用实体牌；虚拟牌不触发。";
              }
            },
            group: "xd_lianheng_record",
            subSkill: {
              record: {
                charlotte: true,
                forced: true,
                popup: false,
                lastDo: true,
                priority: -100,
                trigger: { player: "useCardAfter" },
                content(event, trigger, player) {
                  // “你上次使用牌的目标”应在本次使用完成后才更新。
                  // 若在 useCardBefore 就覆盖，张仪处于阴项时使用一张以自己为目标的牌，
                  // 会把“自己”提前写成上次目标，从而让同一张牌错误地立刻触发阴项并翻回阳。
                  // useCardAfter 记录还能自然保留多目标牌的全部目标。
                  const targets = [];
                  if (Array.isArray(trigger.targets)) targets.push(...trigger.targets);
                  if (trigger.target && !targets.includes(trigger.target)) targets.push(trigger.target);
                  lib.skill.xd_lianheng.setTargets(player, targets);
                }
              }
            }
          },
          xd_haifeng: {
            global: "xd_haifeng_global",
            getOwners() {
              return game.filterPlayer(target => target.isIn() && target.hasSkill("xd_haifeng"));
            },
            getCount(card, player) {
              return lib.skill.xd_jizhi.getLegalTargetCount(card, player);
            },
            distinctCounts(cards, player) {
              const counts = [];
              for (const card of cards || []) {
                const count = lib.skill.xd_haifeng.getCount(card, player);
                if (!Number.isFinite(count) || counts.includes(count)) return null;
                counts.push(count);
              }
              return counts;
            },
            getSha() {
              return { name: "sha", isCard: true };
            },
            getShaCandidates(player, includeUsage = true) {
              const sha = lib.skill.xd_haifeng.getSha();
              return game.players.filter(target => {
                if (!target?.isIn?.()) return false;
                try {
                  return includeUsage
                    ? !!player.canUse(sha, target)
                    : !!player.canUse(sha, target, undefined, false);
                } catch (e) {
                  return false;
                }
              });
            },
            getShaRange(player) {
              const sha = lib.skill.xd_haifeng.getSha();
              let range;
              try { range = lib.filter.selectTarget(sha, player); } catch (e) { range = [1, 1]; }
              if (typeof range === "number") {
                if (range === -1) return [-1, -1];
                return [range, range];
              }
              if (Array.isArray(range)) return [Number(range[0]) || 0, Number(range[1])];
              return [1, 1];
            },
            getSharedTargets(owner, player, candidates) {
              return (candidates || lib.skill.xd_haifeng.getShaCandidates(player, true)).filter(target => {
                if (!target || target === owner) return false;
                return !!lib.skill.xd_hezong.sharedActivatedSkill(owner, target);
              });
            },
            ownerHasCapacity(owner, player, extraCount) {
              if (!owner?.isIn?.() || !owner.hasSkill("xd_haifeng") || extraCount < 2) return false;
              const candidates = lib.skill.xd_haifeng.getShaCandidates(player, true);
              if (!candidates.length) return false;
              const shared = lib.skill.xd_haifeng.getSharedTargets(owner, player, candidates);
              if (shared.length < extraCount) return false;
              const [rawMin] = lib.skill.xd_haifeng.getShaRange(player);
              const min = rawMin === -1 ? candidates.length : Math.max(1, rawMin);
              // “额外指定”不能与正常【杀】目标重合：至少还要为普通目标留出 min 个不同角色。
              return candidates.length >= min + extraCount;
            },
            candidateOwners(player, extraCount) {
              return lib.skill.xd_haifeng.getOwners().filter(owner => lib.skill.xd_haifeng.ownerHasCapacity(owner, player, extraCount));
            }
          },
          xd_haifeng_global: {
            sourceSkill: "xd_haifeng",
            enable: "phaseUse",
            position: "he",
            selectCard: [2, Infinity],
            discard: false,
            lose: false,
            delay: false,
            complexCard: true,
            filter(event, player) {
              const skill = lib.skill.xd_haifeng;
              if (!skill.candidateOwners(player, 2).length) return false;
              const cards = player.getCards("he");
              for (let i = 0; i < cards.length; i++) {
                const a = skill.getCount(cards[i], player);
                for (let j = i + 1; j < cards.length; j++) {
                  if (a !== skill.getCount(cards[j], player)) return true;
                }
              }
              return false;
            },
            filterCard(card, player) {
              const skill = lib.skill.xd_haifeng;
              const selected = ui.selected.cards || [];
              const count = skill.getCount(card, player);
              if (!Number.isFinite(count)) return false;
              if (selected.some(other => skill.getCount(other, player) === count)) return false;

              const nextNum = selected.length + 1;
              if (nextNum >= 2) return skill.candidateOwners(player, nextNum).length > 0;

              // 第一张牌就排除没有任何“不同合法目标数”搭档的死路。
              return player.getCards("he").some(other => {
                if (other === card || skill.getCount(other, player) === count) return false;
                return skill.candidateOwners(player, 2).length > 0;
              });
            },
            prompt: "海锋：选择至少两张合法目标数互不相同的牌当【杀】使用",
            check(card) {
              const player = get.player();
              if ((ui.selected.cards || []).length >= 2) return 0;
              return 7 - get.value(card, player);
            },
            async content(event, trigger, player) {
              const skill = lib.skill.xd_haifeng;
              const cards = [...new Set((event.cards || []).filter(card => player.getCards("he").includes(card)))];
              const extraCount = cards.length;
              if (extraCount < 2 || !skill.distinctCounts(cards, player)) return;

              let owners = skill.candidateOwners(player, extraCount);
              if (!owners.length) return;
              let owner = owners[0];
              if (owners.length > 1) {
                const result = await player.chooseTarget(
                  "【海锋】：选择本次借用哪名角色的【海锋】",
                  true,
                  (card, current, target) => owners.includes(target)
                ).set("ai", target => get.attitude(player, target)).forResult();
                if (!result?.bool || !result.targets?.length) return;
                owner = result.targets[0];
              }

              const candidates = skill.getShaCandidates(player, true);
              if (!candidates.length) return;
              let [min, max] = skill.getShaRange(player);
              if (min === -1) min = candidates.length;
              min = Math.max(1, Number(min) || 1);
              if (max === -1 || !Number.isFinite(max)) max = candidates.length;
              max = Math.min(max, candidates.length - extraCount);
              if (max < min) return;

              const normal = await player.chooseTarget(
                "【海锋】：选择【杀】的通常目标（随后还须额外指定" + get.cnNumber(extraCount) + "名目标）",
                [min, max],
                true,
                (card, current, target) => {
                  if (!candidates.includes(target)) return false;
                  const selected = (ui.selected.targets || []).filter(item => item !== target).concat(target);
                  const remainingShared = skill.getSharedTargets(owner, player, candidates)
                    .filter(item => !selected.includes(item));
                  return remainingShared.length >= extraCount;
                }
              ).set("ai", target => get.effect(target, { name: "sha", isCard: true }, player, player)).forResult();
              if (!normal?.bool || !normal.targets?.length) return;

              const normalTargets = normal.targets.slice();
              const extraPool = skill.getSharedTargets(owner, player, candidates).filter(target => !normalTargets.includes(target));
              if (extraPool.length < extraCount) return;
              const extra = await player.chooseTarget(
                "【海锋】：额外指定" + get.cnNumber(extraCount) + "名与" + get.translation(owner) + "发动过同名技能的角色",
                extraCount,
                true,
                (card, current, target) => extraPool.includes(target)
              ).set("ai", target => get.effect(target, { name: "sha", isCard: true }, player, player)).forResult();
              if (!extra?.bool || extra.targets?.length !== extraCount) return;

              const targets = normalTargets.concat(extra.targets);
              if (owner === player) player.logSkill("xd_haifeng");
              else player.logSkill("xd_haifeng", owner);
              const virtual = get.autoViewAs({ name: "sha", isCard: true }, cards);
              const useEvent = player.useCard(virtual, cards, true, targets, "xd_haifeng_global");
              if (useEvent) await useEvent;
            },
            ai: {
              order: 6.8,
              result: { player: 1 }
            }
          },

          // 施夷光：涟 / 溯
          // 【涟】以实体【闪】印任意即时牌；该牌使用完毕后，选择一个自己当前拥有的技能：
          // 1）立即失效，直到之后再使用X张牌后恢复；或
          // 2）之后再使用X张牌后永久失效。X取本次牌规则意义上的实际目标数。
          // 【溯】只在施夷光自己的回合生效：手牌保留“原牌目标模板”，其余牌面/效果信息映照弃牌堆顶即时牌。
          // 勾践：投醪
          // 规则状态机：
          // 1. 攻击频率与额定摸牌数是整局长期属性，通常基准分别为1、2；这里只记录【投醪】增加量。
          // 2. X始终动态等于两者差的绝对值；正面“把摸牌换成长属”与负面“使用牌无效”共享本轮已用次数。
          // 3. 每轮开始只重置 used 与 armed。armed=false 时，即使 X>0，也不会有任何用牌失效。
          // 4. 只有本轮至少一次主动把摸牌换成长属后，armed=true；此后若“当前需要使用【杀】”，使用任何牌才会无效并消耗一次共享次数。
          // 5. “使用”与“打出”严格区分：只观察 chooseToUse/useCard，不干涉 chooseToRespond。
          xd_toulao: {
            locked: false,
            mark: true,
            marktext: "醪",
            init(player) {
              lib.skill.xd_toulao.getState(player);
              lib.skill.xd_toulao.sync(player);
            },
            onremove(player) {
              player.removeTip?.("xd_toulao_state");
            },
            getState(player) {
              const round = Math.max(0, Math.floor(Number(game.roundNumber) || 0));
              let state = player.storage.xd_toulao_state;
              if (!state || typeof state !== "object") {
                state = player.storage.xd_toulao_state = {
                  round,
                  used: 0,
                  armed: false,
                  attack: 0,
                  draw: 0
                };
              }
              state.attack = Math.max(0, Math.floor(Number(state.attack) || 0));
              state.draw = Math.max(0, Math.floor(Number(state.draw) || 0));
              state.used = Math.max(0, Math.floor(Number(state.used) || 0));
              state.armed = !!state.armed;
              if (state.round !== round) {
                state.round = round;
                state.used = 0;
                state.armed = false;
              }
              return state;
            },
            getAttack(player) {
              return 1 + lib.skill.xd_toulao.getState(player).attack;
            },
            getDraw(player) {
              return 2 + lib.skill.xd_toulao.getState(player).draw;
            },
            getX(player) {
              return Math.abs(lib.skill.xd_toulao.getAttack(player) - lib.skill.xd_toulao.getDraw(player));
            },
            remaining(player) {
              const state = lib.skill.xd_toulao.getState(player);
              return Math.max(0, lib.skill.xd_toulao.getX(player) - state.used);
            },
            sync(player) {
              const skill = lib.skill.xd_toulao;
              const state = skill.getState(player);
              const a = skill.getAttack(player), d = skill.getDraw(player), x = skill.getX(player);
              player.syncStorage?.("xd_toulao_state");
              player.markSkill?.("xd_toulao");
              player.removeTip?.("xd_toulao_state");
              const status = state.armed ? ("代价开启 · 本轮" + state.used + "/" + x) : ("本轮未发动 · " + state.used + "/" + x);
              player.addTip?.("xd_toulao_state", "投醪：攻" + a + " · 摸" + d + " · " + status);
            },
            // 判断本次 chooseToUse 窗口中，一张虚拟【杀】是否当前确实可以使用。
            // 这既排除了 chooseToRespond，也自然覆盖“出牌阶段已经没有杀次数”与“当前根本不是能用杀的窗口”。
            canUseSha(event, player) {
              if (!event || event.name !== "chooseToUse" || event.responded || typeof event.filterCard !== "function") return false;
              const card = get.autoViewAs({ name: "sha", isCard: true }, "unsure");
              try {
                if (!event.filterCard.call(event, card, player, event)) return false;
              } catch (e) {
                return false;
              }
              const info = get.info(card, false);
              if (!info || (typeof info.multicheck === "function" && !info.multicheck(card, player))) return false;
              if (info.notarget) return true;
              let range;
              try {
                range = lib.filter.selectTarget(card, player);
              } catch (e) {
                range = info.selectTarget;
              }
              if (typeof range === "number") range = [range, range];
              if (!Array.isArray(range)) range = [1, 1];
              if (range[0] <= 0 || range[1] === -1) return true;
              const filterTarget = typeof event.filterTarget === "function" ? event.filterTarget : lib.filter.filterTarget;
              let count = 0;
              for (const target of game.players) {
                try {
                  if (filterTarget.call(event, card, player, target)) count++;
                } catch (e) {}
              }
              return count >= range[0];
            },
            findChooseToUse(event) {
              let current = event, guard = 0;
              while (current && guard++ < 24) {
                if (current.name === "chooseToUse") return current;
                let parent = null;
                try {
                  parent = typeof current.getParent === "function" ? current.getParent() : current.parent;
                } catch (e) {
                  parent = current.parent;
                }
                if (!parent || parent === current) break;
                current = parent;
              }
              return null;
            },
            intro: {
              nocount: true,
              content(storage, player) {
                const skill = lib.skill.xd_toulao;
                const state = skill.getState(player);
                const a = skill.getAttack(player), d = skill.getDraw(player), x = skill.getX(player);
                return "攻击频率：" + a +
                  "<br>额定摸牌数：" + d +
                  "<br>X=" + x +
                  "<br>本轮已发动：" + state.used + "/" + x +
                  "<br>本轮失效代价：" + (state.armed ? "已开启" : "未开启");
              },
              markcount(storage, player) {
                return lib.skill.xd_toulao.remaining(player);
              }
            },
            // 长期“攻击频率”只修改【杀】通常可使用次数；其他来源的次数增减继续叠加。
            mod: {
              cardUsable(card, player, num) {
                if (get.name(card, player) !== "sha" || typeof num !== "number" || !Number.isFinite(num)) return;
                return num + lib.skill.xd_toulao.getState(player).attack;
              }
            },
            group: ["xd_toulao_probe", "xd_toulao_invalid", "xd_toulao_draw", "xd_toulao_phaseDraw", "xd_toulao_round"],
            subSkill: {
              // 在真正使用牌前先快照“这一刻是否需要使用【杀】”。
              // 尤其保证最后一次尚可使用的【杀】本身仍按发动前的状态判定，而不是在 useCard1 后才发现次数已耗尽。
              probe: {
                charlotte: true,
                forced: true,
                silent: true,
                popup: false,
                firstDo: true,
                trigger: { player: "chooseToUseBefore" },
                content(event, trigger, player) {
                  trigger._xd_toulao_needSha = lib.skill.xd_toulao.canUseSha(trigger, player);
                }
              },
              // 本轮只有主动发动过正面部分（armed=true）以后，负面部分才存在。
              // 不 cancel 整个 useCard：这张牌仍是“已经使用过”，实体牌与【杀】次数照常消耗，只令其正常效果无效。
              invalid: {
                charlotte: true,
                forced: true,
                popup: false,
                firstDo: true,
                priority: 1000,
                trigger: { player: "useCard1" },
                filter(event, player) {
                  const skill = lib.skill.xd_toulao;
                  const state = skill.getState(player);
                  if (!state.armed || skill.remaining(player) <= 0) return false;
                  const choose = skill.findChooseToUse(event);
                  return !!choose?._xd_toulao_needSha;
                },
                content(event, trigger, player) {
                  const skill = lib.skill.xd_toulao;
                  const state = skill.getState(player);
                  trigger.all_excluded = true;
                  const targets = Array.isArray(trigger.targets) ? trigger.targets.slice() : [];
                  if (targets.length) {
                    if (trigger.excluded?.addArray) trigger.excluded.addArray(targets);
                    else {
                      if (!Array.isArray(trigger.excluded)) trigger.excluded = [];
                      for (const target of targets) if (!trigger.excluded.includes(target)) trigger.excluded.push(target);
                    }
                  }
                  state.used++;
                  player.logSkill("xd_toulao");
                  game.log(player, "因【投醪】令", trigger.card, "无效");
                  skill.sync(player);
                }
              },
              // 任意摸牌时都可选择是否发动；未发动就正常摸牌，也不会因此开启本轮负面代价。
              // 能否主动发动按发动前的当前 X 与本轮 used 判断；发动后立刻修改长期属性，再动态重算新的 X。
              draw: {
                charlotte: true,
                direct: true,
                lastDo: true,
                priority: -1000,
                trigger: { player: "drawBegin" },
                filter(event, player) {
                  return event.num > 0 && lib.skill.xd_toulao.remaining(player) > 0;
                },
                async content(event, trigger, player) {
                  const skill = lib.skill.xd_toulao;
                  const amount = Math.max(0, Math.floor(Number(trigger.num) || 0));
                  if (!amount || skill.remaining(player) <= 0) return;
                  const result = await player.chooseControl("增加攻击频率", "增加额定摸牌数", "不发动投醪")
                    .set("prompt", "【投醪】：是否将本次摸" + amount + "张牌改为增加等量攻击频率或额定摸牌数？")
                    .set("ai", function () {
                      const player = get.player();
                      const skill = lib.skill.xd_toulao;
                      const a = skill.getAttack(player), d = skill.getDraw(player), n = get.event().xd_toulao_amount;
                      // 只给AI一个保守策略：优先选择发动后不会把X明显拉大的方向，否则正常摸牌。
                      const x0 = Math.abs(a - d);
                      const xa = Math.abs((a + n) - d);
                      const xd = Math.abs(a - (d + n));
                      if (Math.min(xa, xd) > x0) return 2;
                      return xa <= xd ? 0 : 1;
                    })
                    .set("xd_toulao_amount", amount)
                    .forResult();
                  if (!result || result.control === "不发动投醪") return;
                  // 再检查一次，避免等待选择期间 X/used 因其他同步事件发生变化。
                  if (skill.remaining(player) <= 0) return;
                  const state = skill.getState(player);
                  trigger.cancel();
                  if (result.control === "增加攻击频率") state.attack += amount;
                  else state.draw += amount;
                  state.used++;
                  state.armed = true;
                  player.logSkill("xd_toulao");
                  game.log(player, "将本次摸", amount, "张牌改为增加", "#y" + amount,
                    result.control === "增加攻击频率" ? "点攻击频率" : "点额定摸牌数");
                  skill.sync(player);
                }
              },
              // 长期“额定摸牌数”改变普通摸牌阶段的基准张数；最终实际要摸多少张，仍由后续 drawBegin 得到。
              phaseDraw: {
                charlotte: true,
                forced: true,
                silent: true,
                popup: false,
                trigger: { player: "phaseDrawBegin2" },
                filter(event, player) {
                  return !event.numFixed && lib.skill.xd_toulao.getState(player).draw > 0;
                },
                content(event, trigger, player) {
                  trigger.num += lib.skill.xd_toulao.getState(player).draw;
                }
              },
              round: {
                charlotte: true,
                forced: true,
                silent: true,
                popup: false,
                trigger: { global: "roundStart" },
                content(event, trigger, player) {
                  const state = lib.skill.xd_toulao.getState(player);
                  state.used = 0;
                  state.armed = false;
                  state.round = Math.max(0, Math.floor(Number(game.roundNumber) || 0));
                  lib.skill.xd_toulao.sync(player);
                }
              }
            }
          },
          // 寒浞【偾骄】：额定摸牌数 D 与本回合允许失去的牌数 X 共享体力上限这一总预算。
          // 达到旧 X 的这次失牌已经成立；随后增长体力上限、重新分配 D/X，并只封锁之后的“使用牌”。
          xd_fenjiao: {
            locked: true,
            forced: true,
            mark: true,
            marktext: "骄",
            init(player) {
              lib.skill.xd_fenjiao.getState(player);
              lib.skill.xd_fenjiao.sync(player);
            },
            onremove(player) {
              delete player.storage.xd_fenjiao_state;
              player.removeSkill?.("xd_fenjiao_block");
              player.removeTip?.("xd_fenjiao_state");
            },
            getState(player) {
              let state = player.storage.xd_fenjiao_state;
              if (!state || typeof state !== "object") {
                state = player.storage.xd_fenjiao_state = {
                  draw: 2,
                  lost: 0,
                  triggered: false
                };
              }
              state.draw = Math.max(0, Math.floor(Number(state.draw) || 0));
              state.lost = Math.max(0, Math.floor(Number(state.lost) || 0));
              state.triggered = !!state.triggered;
              return state;
            },
            getDraw(player) {
              return lib.skill.xd_fenjiao.getState(player).draw;
            },
            getX(player) {
              return Math.floor(Number(player.maxHp) || 0) - lib.skill.xd_fenjiao.getDraw(player);
            },
            getLostCards(event, player) {
              let cards = [];
              try {
                if (typeof event?.getl === "function") {
                  const info = event.getl(player);
                  if (Array.isArray(info?.cards2)) cards.push(...info.cards2);
                  else if (Array.isArray(info?.cards)) cards.push(...info.cards);
                }
              } catch (e) {}
              // 仅 lose 事件的 event.player 才是失牌者；gain/equip/addJudge 的 event.player 是获得方，不能当作失去。
              if (!cards.length && event?.name === "lose" && event.player === player && Array.isArray(event.cards)) {
                cards.push(...event.cards);
              }
              return [...new Set(cards.filter(card => get.itemtype(card) === "card"))];
            },
            sync(player) {
              const skill = lib.skill.xd_fenjiao;
              const state = skill.getState(player);
              const x = skill.getX(player);
              player.syncStorage?.("xd_fenjiao_state");
              player.markSkill?.("xd_fenjiao");
              player.removeTip?.("xd_fenjiao_state");
              const status = player.hasSkill?.("xd_fenjiao_block") ? " · 本回合不能使用牌" : "";
              player.addTip?.("xd_fenjiao_state", `偾骄：额定摸牌${state.draw} · X=${x} · 本回合已失去${state.lost}${status}`);
            },
            intro: {
              nocount: true,
              content(storage, player) {
                const skill = lib.skill.xd_fenjiao;
                const state = skill.getState(player);
                const x = skill.getX(player);
                return "额定摸牌数：" + state.draw +
                  "<br>X：" + x +
                  "<br>本回合已失去：" + state.lost +
                  "<br>本回合是否已发动：" + (state.triggered ? "是" : "否") +
                  (player.hasSkill?.("xd_fenjiao_block") ? "<br>本回合不能使用牌" : "");
              },
              markcount(storage, player) {
                const skill = lib.skill.xd_fenjiao;
                const state = skill.getState(player);
                const x = skill.getX(player);
                if (state.triggered || x <= 0) return 0;
                return Math.max(0, x - state.lost);
              }
            },
            group: ["xd_fenjiao_count", "xd_fenjiao_draw", "xd_fenjiao_turn"],
            subSkill: {
              // 使用无名杀常规“失去牌后”移动事件集合；一次移动只读取该事件记录在寒浞名下的 cards2。
              count: {
                charlotte: true,
                forced: true,
                popup: false,
                trigger: {
                  player: "loseAfter",
                  global: ["equipAfter", "addJudgeAfter", "gainAfter", "loseAsyncAfter", "addToExpansionAfter"]
                },
                filter(event, player) {
                  const skill = lib.skill.xd_fenjiao;
                  const state = skill.getState(player);
                  if (state.triggered || !_status.currentPhase) return false;
                  return skill.getLostCards(event, player).length > 0;
                },
                async content(event, trigger, player) {
                  const skill = lib.skill.xd_fenjiao;
                  const state = skill.getState(player);
                  const lost = skill.getLostCards(trigger, player).length;
                  if (!lost || state.triggered) return;

                  state.lost += lost;
                  skill.sync(player);

                  const oldX = skill.getX(player);
                  if (oldX <= 0 || state.lost < oldX) return;

                  // 同一回合至多成长一次；先锁住状态，避免 gainMaxHp/选择过程中嵌套事件重复进入。
                  state.triggered = true;
                  skill.sync(player);
                  player.logSkill("xd_fenjiao");

                  // 按当前实现口径：本次成长点也可立即自由分配，因此先增长总预算，再重新选择 D。
                  await player.gainMaxHp();

                  const maxHp = Math.max(1, Math.floor(Number(player.maxHp) || 1));
                  const controls = Array.from({ length: maxHp }, (_, i) => `${i}张`);
                  const currentDraw = Math.min(skill.getDraw(player), maxHp - 1);
                  const result = await player.chooseControl(controls)
                    .set("prompt", `【偾骄】：请选择新的额定摸牌数（当前体力上限${maxHp}，X=体力上限-额定摸牌数且须为正）`)
                    .set("ai", () => `${currentDraw}张`)
                    .forResult();
                  let draw = controls.indexOf(result?.control);
                  if (draw < 0 || draw >= maxHp) draw = currentDraw;
                  state.draw = draw;

                  // 只禁止之后的“使用牌”；不封 cardRespondable，因此纯打出响应仍可进行。
                  player.addTempSkill("xd_fenjiao_block", "phaseAfter");
                  skill.sync(player);
                  game.log(player, "将额定摸牌数调整为", "#y" + draw, "，当前X为", "#y" + skill.getX(player));
                }
              },
              // 把“额定摸牌数”作为通常摸牌阶段的基础值差额叠加，不覆盖其他加减摸牌效果。
              draw: {
                charlotte: true,
                forced: true,
                silent: true,
                popup: false,
                trigger: { player: "phaseDrawBegin2" },
                filter(event) {
                  return !event.numFixed;
                },
                content(event, trigger, player) {
                  trigger.num += lib.skill.xd_fenjiao.getDraw(player) - 2;
                }
              },
              // 每个角色的新回合都重新统计；同时作为异常中断情况下的封锁兜底清理。
              turn: {
                charlotte: true,
                forced: true,
                silent: true,
                popup: false,
                firstDo: true,
                trigger: { global: "phaseBefore" },
                content(event, trigger, player) {
                  const state = lib.skill.xd_fenjiao.getState(player);
                  state.lost = 0;
                  state.triggered = false;
                  player.removeSkill?.("xd_fenjiao_block");
                  lib.skill.xd_fenjiao.sync(player);
                }
              },
              block: {
                charlotte: true,
                popup: false,
                mod: {
                  cardEnabled() {
                    return false;
                  },
                  cardSavable() {
                    return false;
                  }
                },
                // UI/mod 是第一层；useCardBefore 再做一次规则兜底，防止技能生成的用牌绕开普通选牌过滤。
                trigger: { player: "useCardBefore" },
                forced: true,
                firstDo: true,
                priority: 100000,
                content(event, trigger) {
                  trigger.cancel();
                }
              }
            }
          },
          xd_lian: {
            enable: "chooseToUse",
            delay: false,
            getChooseToUseEvent(start) {
              let current = start || _status.event, guard = 0;
              while (current && guard++ < 24) {
                if (current.name === "chooseToUse") return current;
                let parent = null;
                try {
                  parent = typeof current.getParent === "function" ? current.getParent() : current.parent;
                } catch (e) {
                  parent = current.parent;
                }
                if (!parent || parent === current) break;
                current = parent;
              }
              return null;
            },
            isImmediateName(name) {
              const info = lib.card[name];
              return !!info && (info.type === "basic" || info.type === "trick");
            },
            // 【涟】必须读取“规则上的当前牌名”，但不能依赖 get.name(card, player)
            // 在【涟】自己的选牌事件里是否恰好吃到【溯】的 cardname mod。
            // 因此【溯】生效时直接按其当前弃牌堆顶判断：
            // 顶牌是【闪】→所有手牌均可作【涟】材料；顶牌不是【闪】→任何手牌（包括印刷【闪】）都不可作材料。
            isShanMaterial(card, player) {
              if (!card || !player) return false;
              const su = lib.skill.xd_su;
              if (su?.active?.(player) && su.isOwnHand(card, player)) {
                const top = su.getTopCard(player);
                return !!top && su.rawName(top) === "shan";
              }
              try {
                return get.name(card, player) === "shan";
              } catch (e) {
                return (card.name || get.name(card, false)) === "shan";
              }
            },
            getLegalVCards(event, player) {
              if (!event || event.responded || typeof event.filterCard !== "function") return [];
              const list = typeof get.inpileVCardList === "function"
                ? get.inpileVCardList(info => {
                    const name = info?.[2], nature = info?.[3];
                    if (!name || !lib.skill.xd_lian.isImmediateName(name)) return false;
                    const data = { name, isCard: true };
                    if (nature) data.nature = nature;
                    let card;
                    try {
                      card = get.autoViewAs(data, "unsure");
                    } catch (e) {
                      card = data;
                    }
                    try {
                      return event.filterCard(card, player, event);
                    } catch (e) {
                      return false;
                    }
                  })
                : [];
              return list || [];
            },
            filter(event, player) {
              if (!event || event.responded || !player.isIn()) return false;
              // 【无懈可击】由 xd_lian_wuxie 走本体原生的直接 viewAs 入口。
              // _wuxie 对 chooseButton → backup 的通用变牌入口存在特殊交互，
              // 会出现技能可点但材料牌全灰、且无法取消的死锁。其他即时牌仍走原【涟】入口。
              if (event.type === "wuxie") return false;
              if (!player.countCards("hs", card => lib.skill.xd_lian.isShanMaterial(card, player))) return false;
              return lib.skill.xd_lian.getLegalVCards(event, player).length > 0;
            },
            hiddenCard(player, name) {
              if (!lib.skill.xd_lian.isImmediateName(name)) return false;
              if (!player.countCards("hs", card => lib.skill.xd_lian.isShanMaterial(card, player))) return false;
              // 【无懈可击】会在真正建立 chooseToUse 之前先询问“是否可能提供无懈”。
              if (name === "wuxie") return true;
              const event = lib.skill.xd_lian.getChooseToUseEvent(_status.event);
              if (!event || event.responded || event.player !== player) return false;
              return lib.skill.xd_lian.getLegalVCards(event, player).some(info => info?.[2] === name);
            },
            isLianUse(event) {
              if (event?.card?.storage?.xd_lian_useId) return true;
              let source = event?.skill;
              const seen = new Set();
              while (source && !seen.has(source)) {
                if (source === "xd_lian") return true;
                seen.add(source);
                const info = lib.skill[source];
                if (!info?.sourceSkill || info.sourceSkill === source) break;
                source = info.sourceSkill;
              }
              return false;
            },
            nextId() {
              game.xd_lian_serial = (Number(game.xd_lian_serial) || 0) + 1;
              return "xd_lian_" + game.xd_lian_serial;
            },
            getSelectableSkills(player) {
              const disabled = player.disabledSkills || {};
              return player.getSkills(null, false, false).filter(skill => {
                if (!skill || skill === "xd_lian_state") return false;
                const info = lib.skill[skill] || {};
                if (info.charlotte || info.superCharlotte || info.ruleSkill || info.silent) return false;
                if (Array.isArray(disabled[skill]) && disabled[skill].length) return false;
                const translated = lib.translate[skill];
                return typeof translated === "string" && translated.length > 0;
              });
            },
            targetCount(useEvent) {
              const targets = [...new Set((useEvent?.targets || []).filter(target => target && typeof target.countCards === "function"))];
              // 无中生有以自己为目标；闪/无懈可击以其响应的牌为目标。
              // 引擎未必都把这些“规则目标”放进角色 targets 数组，因此空数组按1处理。
              return Math.max(1, targets.length);
            },
            ensureStates(player) {
              if (!Array.isArray(player.storage.xd_lian_states)) player.storage.xd_lian_states = [];
              return player.storage.xd_lian_states;
            },
            syncStates(player) {
              if (typeof player.syncStorage === "function") player.syncStorage("xd_lian_states");
              const states = lib.skill.xd_lian.ensureStates(player);
              if (states.length) {
                if (!player.hasSkill("xd_lian_state", null, false)) player.addSkill("xd_lian_state");
                player.markSkill("xd_lian_state");
              } else {
                player.unmarkSkill("xd_lian_state");
                if (player.hasSkill("xd_lian_state", null, false)) player.removeSkill("xd_lian_state");
              }
            },
            // 留给未来“恢复失效技能”的技能直接调用；施夷光自己没有任何自动恢复永久失效技能的入口。
            restoreDisabledSkill(player, skill) {
              if (!player || !skill) return false;
              const states = lib.skill.xd_lian.ensureStates(player);
              let changed = false;
              for (let i = states.length - 1; i >= 0; i--) {
                const state = states[i];
                if (state.skill !== skill || !state.applied) continue;
                try {
                  player.enableSkill(state.source);
                } catch (e) {}
                states.splice(i, 1);
                changed = true;
              }
              if (changed) lib.skill.xd_lian.syncStates(player);
              return changed;
            },
            chooseButton: {
              dialog(event, player) {
                const cards = lib.skill.xd_lian.getLegalVCards(event, player);
                return ui.create.dialog("涟：将一张【闪】当任意即时牌使用", [cards, "vcard"]);
              },
              filter(button, player) {
                const event = lib.skill.xd_lian.getChooseToUseEvent(_status.event);
                if (!event) return false;
                const link = button.link;
                const data = { name: link?.[2], isCard: true };
                if (link?.[3]) data.nature = link[3];
                let card;
                try {
                  card = get.autoViewAs(data, "unsure");
                } catch (e) {
                  card = data;
                }
                try {
                  return event.filterCard(card, player, event);
                } catch (e) {
                  return false;
                }
              },
              check(button) {
                const player = get.player();
                const link = button.link;
                const card = { name: link?.[2], nature: link?.[3], isCard: true };
                return get.useValue(card, player);
              },
              backup(links, player) {
                const link = links[0];
                const data = { name: link?.[2], isCard: true };
                if (link?.[3]) data.nature = link[3];
                return {
                  filterCard(card, player) {
                    return lib.skill.xd_lian.isShanMaterial(card, player);
                  },
                  selectCard: 1,
                  position: "hs",
                  popname: true,
                  sourceSkill: "xd_lian",
                  viewAs: data,
                  onuse(result, player) {
                    if (!result?.card) return;
                    result.card.storage ??= {};
                    result.card.storage.xd_lian_useId = lib.skill.xd_lian.nextId();
                  }
                };
              },
              prompt(links) {
                const link = links[0];
                const card = { name: link?.[2], nature: link?.[3], isCard: true };
                return "将一张【闪】当" + get.translation(card) + "使用";
              }
            },
            ai: {
              order: 7.5,
              respondShan: true,
              save: true,
              skillTagFilter(player, tag, arg) {
                return player.countCards("hs", card => lib.skill.xd_lian.isShanMaterial(card, player)) > 0;
              },
              result: { player: 1 }
            },
            group: ["xd_lian_wuxie", "xd_lian_after"],
            subSkill: {
              // 无懈询问是本体的特殊 _wuxie 流程。
              // 不再经过【涟】的 chooseButton 通用牌名目录，而是像本体标准转化技一样，
              // 直接把一张规则意义上的【闪】视为【无懈可击】使用。这样既能正常选中材料，
              // 也把“取消”完整交还给原生 chooseToUse / _wuxie。
              wuxie: {
                charlotte: true,
                sourceSkill: "xd_lian",
                enable: "chooseToUse",
                delay: false,
                position: "hs",
                selectCard: 1,
                filterCard(card, player) {
                  return lib.skill.xd_lian.isShanMaterial(card, player);
                },
                viewAsFilter(player) {
                  return player.countCards("hs", card => lib.skill.xd_lian.isShanMaterial(card, player)) > 0;
                },
                viewAs: { name: "wuxie", isCard: true },
                popname: true,
                prompt: "将一张【闪】当【无懈可击】使用",
                hiddenCard(player, name) {
                  return name === "wuxie" && player.countCards("hs", card => lib.skill.xd_lian.isShanMaterial(card, player)) > 0;
                },
                check(card) {
                  return 8 - get.value(card);
                },
                onuse(result, player) {
                  if (!result?.card) return;
                  result.card.storage ??= {};
                  result.card.storage.xd_lian_useId ??= lib.skill.xd_lian.nextId();
                }
              },
              after: {
                forced: true,
                popup: false,
                // 【涟】的代价必须在这张转化牌已经正式提交使用后立刻建立。
                // 若等到 useCardAfter，无懈可击的嵌套连锁会把该时点推迟到整段无懈链结束，
                // 于是玩家能在尚未选择任何失效代价前再次发动【涟】。
                // useCard1 已经确定了牌、材料和目标，且无法撤回，同时早于后续无懈询问。
                trigger: { player: "useCard1" },
                filter(event, player) {
                  return lib.skill.xd_lian.isLianUse(event);
                },
                async content(event, trigger, player) {
                  const skill = lib.skill.xd_lian;
                  trigger.card.storage ??= {};
                  trigger.card.storage.xd_lian_useId ??= skill.nextId();
                  const x = skill.targetCount(trigger);
                  const skills = skill.getSelectableSkills(player);
                  if (!skills.length) return;

                  let chosen = skills[0];
                  if (skills.length > 1) {
                    const controls = skills.map(item => get.translation(item));
                    const result = await player.chooseControl(controls)
                      .set("prompt", "【涟】：选择一个技能")
                      .set("choiceList", skills.map(item => "【" + get.translation(item) + "】"))
                      .set("ai", () => controls.includes("涟") ? "涟" : controls[0])
                      .forResult();
                    const index = Math.max(0, controls.indexOf(result?.control));
                    chosen = skills[index] || skills[0];
                  }

                  const skillName = get.translation(chosen);
                  const modes = [
                    "令【" + skillName + "】立即失效，直到你再使用" + x + "张牌后恢复",
                    "令【" + skillName + "】在你再使用" + x + "张牌后永久失效"
                  ];
                  const beforeLabel = "之前失效";
                  const afterLabel = "之后失效";
                  const modeResult = await player.chooseControl([beforeLabel, afterLabel])
                    .set("prompt", "【涟】：令【" + skillName + "】于你再使用" + x + "张牌之前或之后失效")
                    .set("choiceList", modes)
                    .set("ai", () => beforeLabel)
                    .forResult();
                  const mode = modeResult?.control === afterLabel ? "after" : "before";
                  const state = {
                    id: trigger.card.storage.xd_lian_useId,
                    source: "xd_lian_disable_" + trigger.card.storage.xd_lian_useId,
                    skill: chosen,
                    mode,
                    x,
                    used: 0,
                    applied: false,
                    permanent: mode === "after"
                  };
                  skill.ensureStates(player).push(state);
                  if (!player.hasSkill("xd_lian_state", null, false)) player.addSkill("xd_lian_state");

                  if (mode === "before") {
                    player.disableSkill(state.source, chosen);
                    state.applied = true;
                    game.log(player, "令", "#g【" + skillName + "】", "立即失效，直到再使用", x, "张牌后恢复");
                  } else {
                    game.log(player, "令", "#g【" + skillName + "】", "在再使用", x, "张牌后永久失效");
                  }
                  skill.syncStates(player);
                }
              }
            }
          },
          xd_lian_state: {
            charlotte: true,
            forced: true,
            popup: false,
            lastDo: true,
            mark: true,
            marktext: "涟",
            intro: {
              nocount: true,
              content(storage, player) {
                const states = lib.skill.xd_lian.ensureStates(player);
                if (!states.length) return "没有【涟】的失效状态。";
                return states.map(state => {
                  const name = get.translation(state.skill);
                  if (state.mode === "before") {
                    return "【" + name + "】当前失效；还需使用" + Math.max(0, state.x - state.used) + "张牌后恢复。";
                  }
                  if (!state.applied) {
                    return "【" + name + "】还需使用" + Math.max(0, state.x - state.used) + "张牌后永久失效。";
                  }
                  return "【" + name + "】已永久失效。";
                }).join("<br>");
              }
            },
            trigger: { player: "useCardAfter" },
            async content(event, trigger, player) {
              const lian = lib.skill.xd_lian;
              const states = lian.ensureStates(player);
              if (!states.length) return;
              let changed = false;
              for (let i = states.length - 1; i >= 0; i--) {
                const state = states[i];
                // 新状态由这次【涟】用牌结算完才建立；保险起见也显式排除自己的起源牌。
                if (trigger.card?.storage?.xd_lian_useId === state.id) continue;
                if (state.mode === "after" && state.applied) continue;
                state.used++;
                changed = true;
                if (state.used < state.x) continue;

                if (state.mode === "before") {
                  try {
                    player.enableSkill(state.source);
                  } catch (e) {}
                  game.log(player, "再使用了", state.x, "张牌，", "#g【" + get.translation(state.skill) + "】", "恢复生效");
                  states.splice(i, 1);
                } else {
                  player.disableSkill(state.source, state.skill);
                  state.applied = true;
                  state.used = state.x;
                  game.log(player, "再使用了", state.x, "张牌，", "#g【" + get.translation(state.skill) + "】", "永久失效");
                }
              }
              if (changed) lian.syncStates(player);
            }
          },
          xd_su: {
            locked: true,
            forced: true,
            delay: false,
            // 【溯】本身不是一个需要点击的发动入口。
            // 在施夷光自己的回合、且当前弃牌堆顶是即时牌时，它直接把所有手牌映照为顶牌；
            // 真实手牌只保留自己的“目标模板”，其余牌名/属性/花色/点数/效果都来自顶牌。
            // 【溯】只认弃牌堆顶实体牌本来的牌面。
            // 一张装备牌即使刚才被【溯】当【无中生有】使用，进入弃牌堆后仍然只是装备牌；
            // 它处在堆顶时，【溯】必须暂停，不能跳过它继续寻找更下面的即时牌。
            // 永远在实体牌还没有进入 viewAs 之前记住它的印刷牌面。
            // 这样一张装备牌即使稍后被【溯】当【无中生有】使用，进入弃牌堆后仍按装备牌判断。
            stampPrinted(card) {
              if (!card) return;
              card.storage ??= {};
              if (!card.storage.xd_su_printedName) {
                card.storage.xd_su_printedName = card.name || get.name(card, false);
              }
              if (!card.storage.xd_su_printedType) {
                const name = card.storage.xd_su_printedName;
                card.storage.xd_su_printedType = lib.card?.[name]?.type || card.type || get.type({ name }, null, false) || get.type(card, null, false);
              }
            },
            rawName(card) {
              return card?.storage?.xd_su_printedName || card?.name || get.name(card, false);
            },
            rawType(card) {
              if (!card) return null;
              if (card?.storage?.xd_su_printedType) return card.storage.xd_su_printedType;
              const name = lib.skill.xd_su.rawName(card);
              return lib.card?.[name]?.type || card.type || get.type({ name }, null, false) || get.type(card, null, false);
            },
            isImmediate(card) {
              const type = lib.skill.xd_su.rawType(card);
              return type === "basic" || type === "trick";
            },
            cardId(card) {
              if (!card) return null;
              return card.cardid || card.cardId || card.dataset?.cardId || null;
            },
            isInDiscard(card) {
              if (!card) return false;
              try {
                return get.position(card, true) === "d" || card.parentNode === ui.discardPile;
              } catch (e) {
                return card.parentNode === ui.discardPile;
              }
            },
            // 无名杀对“使用牌的实体材料何时真正进入弃牌堆”有自己的 ordering 结算。
            // 【溯】因此不再每次临时扫弃牌堆来猜顶部，而是在西施回合内维护一个真正按移动时序更新的“有序弃牌堆顶”。
            // 这也正对应作者所说“只有西施用到了仅限她回合内的有序弃牌堆”。
            resetTurnTracking(player) {
              if (!player) return;
              delete player.storage.xd_su_ordered_top;
              delete player.storage.xd_su_turn_discard_ids;
              player._xd_su_ordered_top_ref = null;
              player._xd_su_turn_discard_refs = new Set();
            },
            markTurnDiscard(player, card) {
              if (!player || !card) return;
              if (!(player._xd_su_turn_discard_refs instanceof Set)) player._xd_su_turn_discard_refs = new Set();
              player._xd_su_turn_discard_refs.add(card);
              const id = lib.skill.xd_su.cardId(card);
              if (id) {
                if (!Array.isArray(player.storage.xd_su_turn_discard_ids)) player.storage.xd_su_turn_discard_ids = [];
                if (!player.storage.xd_su_turn_discard_ids.includes(id)) player.storage.xd_su_turn_discard_ids.push(id);
              }
            },
            isTurnDiscard(player, card) {
              if (!player || !card) return false;
              if (player._xd_su_turn_discard_refs instanceof Set && player._xd_su_turn_discard_refs.has(card)) return true;
              const id = lib.skill.xd_su.cardId(card);
              return !!(id && Array.isArray(player.storage.xd_su_turn_discard_ids) && player.storage.xd_su_turn_discard_ids.includes(id));
            },
            setOrderedTop(player, card) {
              if (!player) return;
              if (!card || !lib.skill.xd_su.isInDiscard(card)) {
                delete player.storage.xd_su_ordered_top;
                player._xd_su_ordered_top_ref = null;
                return;
              }
              lib.skill.xd_su.stampPrinted(card);
              player._xd_su_ordered_top_ref = card;
              player.storage.xd_su_ordered_top = lib.skill.xd_su.cardId(card) || null;
            },
            getPhysicalTopCard() {
              try {
                return get.discardPile(true, "top") || null;
              } catch (e) {
                try {
                  return get.discardPile(true) || null;
                } catch (e2) {
                  return null;
                }
              }
            },
            getOrderedTop(player) {
              if (!player || _status.currentPhase !== player) return null;
              const skill = lib.skill.xd_su;
              let card = player._xd_su_ordered_top_ref;
              if (card && skill.isInDiscard(card)) return card;
              const id = player.storage.xd_su_ordered_top;
              if (id && ui.discardPile?.childNodes) {
                card = Array.from(ui.discardPile.childNodes).find(current => skill.cardId(current) === id) || null;
                if (card && skill.isInDiscard(card)) {
                  player._xd_su_ordered_top_ref = card;
                  return card;
                }
              }
              // 只承认西施本回合开始后真正进入弃牌堆的牌。
              // 若当前追踪的顶牌离开弃牌堆，可以回退到物理堆顶，但该牌也必须属于本回合的追踪集合；
              // 绝不能把西施回合开始前别人留下的旧弃牌当作【溯】的起点。
              card = skill.getPhysicalTopCard();
              if (card && skill.isTurnDiscard(player, card)) {
                skill.setOrderedTop(player, card);
                return card;
              }
              skill.setOrderedTop(player, null);
              return null;
            },
            recordDiscardEntry(player, cards) {
              if (!player || _status.currentPhase !== player) return;
              const skill = lib.skill.xd_su;
              const entered = [...new Set((cards || []).filter(card => skill.isInDiscard(card)))];
              if (!entered.length) return;
              for (const card of entered) {
                skill.stampPrinted(card);
                skill.markTurnDiscard(player, card);
              }

              // 单牌进入弃牌堆时毫无歧义：它就是新的堆顶。
              // 多牌同时进入时，优先根据弃牌堆 DOM 的端点判断哪一张实际位于最上层；
              // 若本体 UI 无法提供端点，再采用事件中最后一张作为兜底。
              let top = null;
              const first = ui.discardPile?.firstChild || null;
              const last = ui.discardPile?.lastChild || null;
              const firstIn = first && entered.includes(first);
              const lastIn = last && entered.includes(last);
              if (entered.length === 1) top = entered[0];
              else if (firstIn && !lastIn) top = first;
              else if (lastIn && !firstIn) top = last;
              else {
                try {
                  const apiTop = skill.getPhysicalTopCard();
                  if (apiTop && entered.includes(apiTop)) top = apiTop;
                } catch (e) {}
                if (!top) top = entered[entered.length - 1];
              }
              skill.setOrderedTop(player, top);
            },
            getTopCard(player) {
              if (!player || _status.currentPhase !== player) return null;
              const card = lib.skill.xd_su.getOrderedTop(player);
              return card && lib.skill.xd_su.isImmediate(card) ? card : null;
            },
            active(player) {
              if (!(player?.isIn?.() && _status.currentPhase === player)) return false;
              if (!player.hasSkill?.("xd_su", null, false)) return false;
              const disabled = player.disabledSkills?.xd_su;
              if (Array.isArray(disabled) ? disabled.length > 0 : !!disabled) return false;
              return !!lib.skill.xd_su.getTopCard(player);
            },
            isOwnHand(card, player) {
              return !!(card && player && player.getCards("h").includes(card));
            },
            getChooseToUseEvent(start) {
              return lib.skill.xd_qiusuo.getChooseToUseEvent(start);
            },
            makeEffectCard(template) {
              if (!template) return null;
              const name = lib.skill.xd_su.rawName(template);
              if (!name) return null;
              const data = {
                name,
                suit: template.suit ?? get.suit(template, false),
                number: template.number ?? get.number(template, false),
                isCard: true
              };
              const nature = template.nature ?? get.nature(template, false);
              if (nature) data.nature = nature;
              try {
                return get.autoViewAs(data, "unsure");
              } catch (e) {
                return data;
              }
            },
            effectAllowedByOuter(outer, effectCard, player) {
              return lib.skill.xd_qiusuo.effectAllowedByOuter(outer, effectCard, player);
            },
            getTemplateRuleCard(card) {
              return lib.skill.xd_qiusuo.getTargetRuleCard(card);
            },
            getTemplateRange(card, player) {
              const rule = lib.skill.xd_su.getTemplateRuleCard(card);
              const rawName = get.name(card, false) || card?.name;
              // 规则意义上【无中生有】的目标是自己；本体有时用 notarget 表示自动指向自己，
              // 这里把它还原成“唯一目标为自己”的目标模板。
              if (rawName === "wuzhong") return [-1, -1];
              return lib.skill.xd_qiusuo.getTemplateRange(rule, player);
            },
            templateTargetEnabled(card, player, target) {
              const rawName = get.name(card, false) || card?.name;
              if (rawName === "wuzhong") return target === player;
              return lib.skill.xd_qiusuo.targetEnabledByTemplate(
                lib.skill.xd_su.getTemplateRuleCard(card),
                player,
                target
              );
            },
            clearCache(event) {
              for (const key of ["_cardChoice", "_targetChoice", "_skillChoice"]) delete event[key];
            },
            closeUseState(event) {
              const q = event?._xd_su_direct;
              if (!q) return;
              q.material = null;
              q.top = null;
              q.effectCard = null;
            },
            // 直接点击已经被【溯】改名的手牌时，偷偷切换到一个不显示按钮的原生 backup：
            // 效果牌 = 弃牌堆顶；实体材料/目标模板 = 被点击的原手牌。
            // 玩家看到的仍然只是“手牌已经变成顶牌”，不需要点【溯】。
            setupDirectUse(event) {
              if (!event?.player || event._xd_su_direct || typeof event.filterCard !== "function") return;
              const player = event.player;
              const skill = lib.skill.xd_su;
              const state = event._xd_su_direct = {
                material: null,
                top: null,
                effectCard: null
              };
              event.custom ||= { add: {}, replace: {} };
              event.custom.add ||= {};
              event.custom.replace ||= {};

              const previousCard = event.custom.replace.card;
              const previousConfirm = event.custom.replace.confirm;
              const originalRestore = event.restore;

              event.restore = function () {
                skill.closeUseState(event);
                const result = originalRestore.apply(this, arguments);
                skill.clearCache(event);
                return result;
              };

              const nativeClick = card => {
                const own = event.custom.replace.card;
                const clicked = _status.clicked;
                if (previousCard) event.custom.replace.card = previousCard;
                else delete event.custom.replace.card;
                _status.clicked = false;
                try {
                  ui.click.card.call(card);
                } finally {
                  event.custom.replace.card = own;
                  _status.clicked = clicked;
                }
              };

              event.custom.replace.card = function (card) {
                if (event.skill === "xd_su_use") {
                  // 已经进入隐藏 backup：第二次点击同一张牌交回原生取消/重选逻辑。
                  nativeClick(card);
                  return;
                }
                // 其他技能（包括【涟】）拥有自己的选牌规则，不让【溯】截走它们的材料点击。
                if (event.skill || !skill.active(player) || !skill.isOwnHand(card, player)) {
                  nativeClick(card);
                  return;
                }

                const top = skill.getTopCard(player);
                const effectCard = skill.makeEffectCard(top);
                if (!top || !effectCard || !skill.effectAllowedByOuter(event, effectCard, player)) {
                  nativeClick(card);
                  return;
                }

                // 在任何 backup/viewAs 介入之前就冻结实体材料的印刷牌面。
                skill.stampPrinted(card);
                game.uncheck();
                state.material = card;
                state.top = top;
                state.effectCard = effectCard;
                event.backup("xd_su_use");
                skill.clearCache(event);
                game.check();
                nativeClick(card);
              };

              event.custom.replace.confirm = function (ok) {
                // 从隐藏 backup 取消时，只退回本次普通出牌询问，不结束整个出牌阶段。
                if (!ok && event.skill === "xd_su_use") {
                  game.uncheck();
                  event.restore();
                  game.check();
                  return;
                }
                const own = event.custom.replace.confirm;
                if (previousConfirm) event.custom.replace.confirm = previousConfirm;
                else delete event.custom.replace.confirm;
                try {
                  (ok ? ui.click.ok : ui.click.cancel)();
                } finally {
                  event.custom.replace.confirm = own;
                }
              };

              const cleanup = game.createEvent("xd_su_choose_cleanup", false);
              event.next?.remove(cleanup);
              _status.event?.next?.remove(cleanup);
              event.after.push(cleanup);
              cleanup.setContent(async () => skill.closeUseState(event));
            },
            onChooseToUse(event) {
              lib.skill.xd_su.setupDirectUse(event);
            },
            hiddenCard(player, name) {
              const top = lib.skill.xd_su.getTopCard(player);
              if (!top || !player.countCards("h")) return false;
              return lib.skill.xd_su.rawName(top) === name;
            },
            mod: {
              // UI 与所有普通牌名判断都直接看到弃牌堆顶的即时牌。
              cardname(card, player) {
                const skill = lib.skill.xd_su;
                const top = skill.getTopCard(player);
                if (!top || !skill.isOwnHand(card, player)) return;
                return skill.rawName(top);
              },
              cardnature(card, player) {
                const skill = lib.skill.xd_su;
                const top = skill.getTopCard(player);
                if (!top || !skill.isOwnHand(card, player)) return;
                return get.nature(top, false) || false;
              },
              suit(card, suit) {
                const player = get.owner(card);
                const skill = lib.skill.xd_su;
                const top = skill.getTopCard(player);
                if (!top || !skill.isOwnHand(card, player)) return;
                return get.suit(top, false);
              },
              cardnumber(card, player, number) {
                const skill = lib.skill.xd_su;
                const top = skill.getTopCard(player);
                if (!top || !skill.isOwnHand(card, player)) return;
                return get.number(top, false);
              }
            },
            group: ["xd_su_fix", "xd_su_reset", "xd_su_track", "xd_su_clear"],
            subSkill: {
              // 每次西施自己的回合真正开始时，从空状态重新统计。
              // 回合开始前弃牌堆里原有的任何牌都不属于本回合【溯】。
              reset: {
                charlotte: true,
                forced: true,
                popup: false,
                firstDo: true,
                trigger: { player: "phaseBefore" },
                content(event, trigger, player) {
                  lib.skill.xd_su.resetTurnTracking(player);
                }
              },
              // 西施回合内，任何实体牌真正进入弃牌堆时都更新“有序弃牌堆顶”。
              // 尤其是【溯】的实体材料：它先进入 ordering，等真正落入弃牌堆的事件发生后，
              // 才会成为新的堆顶；此时按其印刷类型重新判断【溯】是否继续生效。
              track: {
                charlotte: true,
                forced: true,
                popup: false,
                firstDo: true,
                trigger: { global: ["cardsDiscardAfter", "loseAfter", "loseAsyncAfter"] },
                filter(event, player) {
                  if (_status.currentPhase !== player) return false;
                  const cards = [];
                  if (Array.isArray(event.cards)) cards.push(...event.cards);
                  if (Array.isArray(event.cards2)) cards.push(...event.cards2);
                  return cards.some(card => lib.skill.xd_su.isInDiscard(card));
                },
                content(event, trigger, player) {
                  const cards = [];
                  if (Array.isArray(trigger.cards)) cards.push(...trigger.cards);
                  if (Array.isArray(trigger.cards2)) cards.push(...trigger.cards2);
                  lib.skill.xd_su.recordDiscardEntry(player, cards);
                  const outer = lib.skill.xd_su.getChooseToUseEvent(_status.event);
                  if (outer) lib.skill.xd_su.clearCache(outer);
                  if (typeof game.check === "function") game.check();
                }
              },
              clear: {
                charlotte: true,
                forced: true,
                popup: false,
                lastDo: true,
                trigger: { player: "phaseAfter" },
                content(event, trigger, player) {
                  lib.skill.xd_su.resetTurnTracking(player);
                }
              },
              fix: {
                charlotte: true,
                forced: true,
                popup: false,
                firstDo: true,
                trigger: { player: "useCard1" },
                filter(event, player) {
                  const source = event.skill || event.sourceSkill;
                  return source === "xd_su_use" || source === "xd_su";
                },
                content(event, trigger, player) {
                  // 某些效果牌（如铁索）自身会在 useCard 建立时加工目标。
                  // 【溯】要求目标只由原材料模板决定，因此以 backup 保存的原始目标覆盖回来。
                  const saved = trigger.card?.storage?.xd_su_targets;
                  if (Array.isArray(saved)) {
                    const targets = saved
                      .map(id => game.players.concat(game.dead || []).find(current => current.playerid === id))
                      .filter(Boolean);
                    trigger.targets = [...new Set(targets)];
                    trigger._targets = trigger.targets.slice();
                  }
                  trigger._xd_su_composite = true;
                  trigger._xd_su_targetTemplate = trigger.card?.storage?.xd_su_targetTemplate || null;
                  trigger._xd_su_effectTemplate = trigger.card?.storage?.xd_su_effectTemplate || null;
                }
              }
            },
            ai: {
              order: 7.1
            }
          },
          // 【溯】的隐藏原生 backup：不显示技能按钮，只由直接点击已变名的手牌进入。
          xd_su_use: {
            charlotte: true,
            popup: false,
            sourceSkill: "xd_su",
            position: "h",
            selectCard: 1,
            filterCard(card, player) {
              const outer = lib.skill.xd_su.getChooseToUseEvent(_status.event) || _status.event;
              const state = outer?._xd_su_direct;
              return !!(state?.material && card === state.material && lib.skill.xd_su.active(player));
            },
            viewAs(cards, player) {
              const outer = lib.skill.xd_su.getChooseToUseEvent(_status.event) || _status.event;
              const state = outer?._xd_su_direct;
              const top = state?.top || lib.skill.xd_su.getTopCard(player);
              const effect = lib.skill.xd_su.makeEffectCard(top);
              if (!effect) return;
              return {
                name: effect.name,
                nature: effect.nature,
                suit: effect.suit,
                number: effect.number,
                isCard: true,
                storage: {
                  xd_su: true,
                  xd_su_targetTemplate: state?.material ? (get.name(state.material, false) || state.material.name) : null,
                  xd_su_effectTemplate: top ? lib.skill.xd_su.rawName(top) : null
                }
              };
            },
            filterTarget(card, player, target) {
              const outer = lib.skill.xd_su.getChooseToUseEvent(_status.event) || _status.event;
              const material = outer?._xd_su_direct?.material;
              if (!material) return false;
              return lib.skill.xd_su.templateTargetEnabled(material, player, target);
            },
            selectTarget(card, player) {
              const outer = lib.skill.xd_su.getChooseToUseEvent(_status.event) || _status.event;
              const material = outer?._xd_su_direct?.material;
              if (!material) return [0, 0];
              const range = lib.skill.xd_su.getTemplateRange(material, player);
              if (range[0] === range[1]) return range[0];
              return range;
            },
            complexTarget: true,
            complexSelect: true,
            check(card) {
              return get.value(card, get.player());
            },
            onuse(result, player) {
              const outer = lib.skill.xd_su.getChooseToUseEvent(_status.event) || _status.event;
              const state = outer?._xd_su_direct;
              if (!result?.card || !state?.material) return;
              result.card.storage ??= {};
              result.card.storage.xd_su = true;
              result.card.storage.xd_su_targetTemplate = get.name(state.material, false) || state.material.name;
              result.card.storage.xd_su_effectTemplate = state.top ? lib.skill.xd_su.rawName(state.top) : null;
              result.card.storage.xd_su_targets = (result.targets || []).map(target => target.playerid);
              state.material.storage ??= {};
              state.material.storage.xd_su_printedName ??= state.material.name || get.name(state.material, false);
              state.material.storage.xd_su_printedType ??= lib.card?.[state.material.storage.xd_su_printedName]?.type || state.material.type || get.type({ name: state.material.storage.xd_su_printedName }, null, false);
            }
          },

          // 屈原：求索 / 天问
          // 【求索】在一次 chooseToUse 中反复拼点，直到屈原真正拼输；平点、获胜均继续。
          // 所有拼点牌都会进入最终“花色/点数池”，其中即时牌另进入“目标模板/效果模板池”。
          // 组合牌为无花色、无点数的纯虚拟牌；属性【杀】继承效果模板的属性。
          xd_qiusuo: {
            enable: "chooseToUse",
            filterCard: () => false,
            selectCard: -1,
            filterTarget: () => false,
            selectTarget: -1,
            delay: false,
            isImmediate(card) {
              const type = get.type(card, null, false);
              return type === "basic" || type === "trick";
            },
            getChooseToUseEvent(start) {
              let current = start || _status.event, guard = 0;
              while (current && guard++ < 24) {
                if (current.name === "chooseToUse") return current;
                let parent = null;
                try {
                  parent = typeof current.getParent === "function" ? current.getParent() : current.parent;
                } catch (e) {
                  parent = current.parent;
                }
                if (!parent || parent === current) break;
                current = parent;
              }
              return null;
            },
            getOtherHandTargets(player) {
              return game.filterPlayer(current => current !== player && current.isIn() && current.countCards("h") > 0);
            },
            getModes(player) {
              const others = lib.skill.xd_qiusuo.getOtherHandTargets(player);
              const modes = [];
              if (player.countCards("h") > 0 && others.length) modes.push("normal");
              if (player.countCards("h") > 0) modes.push("skyTarget");
              if (others.length) modes.push("skySelf");
              return modes;
            },
            filter(event, player) {
              if (!event || event.responded || !player.isIn()) return false;
              return lib.skill.xd_qiusuo.getModes(player).length > 0;
            },
            hiddenCard(player, name) {
              const event = _status.event;
              if (!event || event.name !== "chooseToUse" || event.responded) return false;
              if (!lib.skill.xd_qiusuo.getModes(player).length) return false;
              // 求索最终可能从拼点牌里组合出任意即时牌；这里仅负责让响应窗口保留技能入口。
              const info = lib.card[name];
              return !!info && ["basic", "trick"].includes(info.type);
            },
            async chooseRoundRoute(player) {
              const skill = lib.skill.xd_qiusuo;
              const others = skill.getOtherHandTargets(player);
              const hasHand = player.countCards("h") > 0;
              if (!hasHand && !others.length) return null;
              // 没有其他可拼点角色时，只可能“自己的手牌 vs 牌堆顶”。
              if (hasHand && !others.length) return { mode: "skyTarget", target: null };

              const min = hasHand ? 0 : 1;
              const result = await player.chooseTarget({
                prompt: hasHand
                  ? "【求索】：选择一名其他角色拼点；不选择角色直接确定，则与牌堆顶拼点"
                  : "【求索】：选择一名其他角色拼点（你没有手牌，只能通过【天问】用牌堆顶的牌拼点）",
                forced: true,
                selectTarget: [min, 1],
                filterTarget(card, player, target) {
                  return target !== player && target.isIn() && target.countCards("h") > 0;
                },
                ai(target) {
                  const player = get.player();
                  return -get.attitude(player, target) + Math.max(0, 8 - target.countCards("h")) / 10;
                }
              }).forResult();
              const target = result?.targets?.[0] || null;
              if (!target) return { mode: "skyTarget", target: null };
              if (!hasHand) return { mode: "skySelf", target };
              return { mode: "target", target };
            },
            async chooseCompareTarget(player, prompt) {
              const targets = lib.skill.xd_qiusuo.getOtherHandTargets(player);
              if (!targets.length) return null;
              if (targets.length === 1) return targets[0];
              const result = await player.chooseTarget({
                prompt,
                forced: true,
                filterTarget(card, player, target) {
                  return target !== player && target.isIn() && target.countCards("h") > 0;
                },
                ai(target) {
                  const player = get.player();
                  return -get.attitude(player, target) + Math.max(0, 8 - target.countCards("h")) / 10;
                }
              }).forResult();
              return result?.bool && result.targets?.length ? result.targets[0] : null;
            },
            async compareOnce(player, mode, target) {
              let next, topCard = null;
              if (mode === "skyTarget") {
                // 不选角色直接确定：屈原必须用自己的手牌，与牌堆顶拼点。
                next = player.chooseToCompare("cardPile");
                next._xd_qiusuo_skyTarget = true;
                next._xd_tianwen_block_selfTop = true;
                next._xd_tianwen_mode = "skyTarget";
              } else if (mode === "skySelf") {
                // 仅在屈原已经没有手牌时使用的保底路径；正常有手牌时由【天问】onCompare按钮完成。
                topCard = get.cards(1)?.[0];
                if (!topCard) return null;
                await game.cardsGotoOrdering(topCard);
                next = player.chooseToCompare(target);
                next.fixedResult = { [player.playerid]: topCard };
                next._xd_tianwen_applied = true;
                next._xd_tianwen_mode = "skySelf";
                next._xd_qiusuo_inside_target = true;
              } else {
                // 先选角色，再进入原生拼点选牌；此时上方会出现【天问】按钮，
                // 可不选手牌而改用牌堆顶的牌与刚才的目标拼点。
                next = player.chooseToCompare(target);
                next._xd_qiusuo_inside_target = true;
              }
              const result = await next.forResult();
              if (!result || result.cancelled) return null;
              const usedMode = next._xd_tianwen_mode || (mode === "target" ? "normal" : mode);
              const card1 = result.player || next.card1;
              const card2 = result.target || next.card2;
              const num1 = Number(result.num1 ?? get.number(card1, player));
              const num2 = Number(result.num2 ?? get.number(card2, target || false));
              return {
                mode: usedMode,
                target,
                card1,
                card2,
                num1,
                num2,
                tie: num1 === num2,
                lost: num1 < num2,
                winner: num1 < num2 ? (usedMode === "skyTarget" ? "sky" : target) : (num1 > num2 ? player : null)
              };
            },
            async chooseTemplateCard(player, cards, prompt) {
              if (!cards?.length) return null;
              if (cards.length === 1) return cards[0];
              const dialog = ui.create.dialog(prompt, cards);
              const result = await player.chooseButton(dialog, true)
                .set("ai", button => get.value(button.link, player))
                .forResult();
              return result?.bool && result.links?.length ? result.links[0] : null;
            },
            makeVirtualEffect(card) {
              if (!card) return null;
              const name = get.name(card, false) || card.name;
              if (!name) return null;
              const data = { name, isCard: true };
              const nature = get.nature(card, false) || card.nature;
              if (nature) data.nature = nature;
              // 不写 suit / number：组合牌明确为无花色、无点数的虚拟牌。
              try {
                return get.autoViewAs(data, "unsure");
              } catch (e) {
                return data;
              }
            },
            getTargetRuleCard(card) {
              if (!card) return null;
              const data = {
                name: get.name(card, false) || card.name,
                nature: get.nature(card, false) || card.nature,
                isCard: true
              };
              try {
                return get.autoViewAs(data, "unsure");
              } catch (e) {
                return data;
              }
            },
            targetEnabledByTemplate(ruleCard, player, target) {
              if (!ruleCard || !target) return false;
              const info = get.info(ruleCard, false) || {};
              try {
                if (typeof info.filterTarget === "function" && !info.filterTarget(ruleCard, player, target)) return false;
                if (typeof lib.filter.targetEnabled2 === "function" && !lib.filter.targetEnabled2(ruleCard, player, target)) return false;
                if (typeof lib.filter.targetInRange === "function" && !lib.filter.targetInRange(ruleCard, player, target)) return false;
                return true;
              } catch (e) {
                try {
                  return !!player.canUse(ruleCard, target, undefined, false);
                } catch (e2) {
                  return false;
                }
              }
            },
            getTemplateRange(ruleCard, player) {
              const info = get.info(ruleCard, false) || {};
              if (info.notarget) return [0, 0];
              // 借刀等 singleCard 牌：其“目标模板”只取主目标；addedTarget 属于牌自身效果内部结构。
              if (info.singleCard) return [1, 1];
              let range;
              try {
                range = lib.filter.selectTarget(ruleCard, player);
              } catch (e) {
                range = info.selectTarget;
                if (typeof range === "function") {
                  try { range = range(ruleCard, player); } catch (e2) { range = 1; }
                }
              }
              if (typeof range === "number") {
                if (range === -1) return [-1, -1];
                return [range, range];
              }
              if (Array.isArray(range)) return [range[0], range[1]];
              return [1, 1];
            },
            async chooseTargetsByTemplate(player, templateCard, effectCard) {
              const skill = lib.skill.xd_qiusuo;
              const ruleCard = skill.getTargetRuleCard(templateCard);
              const info = get.info(ruleCard, false) || {};
              const range = skill.getTemplateRange(ruleCard, player);
              if (range[0] === 0 && range[1] === 0) return [];
              if (range[0] === -1 && range[1] === -1) {
                return game.filterPlayer(target => skill.targetEnabledByTemplate(ruleCard, player, target));
              }
              const result = await player.chooseTarget({
                prompt: "【求索】：按" + get.translation(ruleCard) + "的目标规则，为" + get.translation(effectCard) + "选择目标",
                forced: true,
                selectTarget: range,
                complexTarget: !!info.complexTarget,
                complexSelect: !!info.complexSelect,
                filterTarget(card, player, target) {
                  return lib.skill.xd_qiusuo.targetEnabledByTemplate(get.event().xd_qiusuo_ruleCard, player, target);
                },
                ai(target) {
                  const player = get.player();
                  const card = get.event().xd_qiusuo_effectCard;
                  return get.effect(target, card, player, player);
                }
              }).set("xd_qiusuo_ruleCard", ruleCard).set("xd_qiusuo_effectCard", effectCard).forResult();
              if (!result?.bool) return null;
              return result.targets || [];
            },
            effectAllowedByOuter(outer, effectCard, player) {
              if (!effectCard || !player) return false;
              try {
                // “效果牌”决定最终视为使用的牌，因此它必须在当前用牌环境中本身可用。
                // 这里同时检查当前询问、牌是否可用、以及使用次数限制；例如出牌阶段已经
                // 用尽【杀】次数后，【杀】仍可作为“目标模板”，但不能再作为“效果模板”。
                if (outer && typeof outer.filterCard === "function" && !outer.filterCard(effectCard, player, outer)) return false;
                if (typeof lib.filter.cardEnabled === "function" && !lib.filter.cardEnabled(effectCard, player, outer)) return false;
                if (typeof lib.filter.cardUsable === "function" && !lib.filter.cardUsable(effectCard, player, outer)) return false;
                return true;
              } catch (e) {
                return false;
              }
            },
            async useComposite(player, outer, targetTemplate, effectTemplate) {
              const skill = lib.skill.xd_qiusuo;
              const effectCard = skill.makeVirtualEffect(effectTemplate);
              if (!effectCard) return false;
              if (!skill.effectAllowedByOuter(outer, effectCard, player)) {
                game.log(player, "由【求索】组合出的", effectCard, "不符合当前用牌要求，未使用此牌");
                return false;
              }
              let targets = await skill.chooseTargetsByTemplate(player, targetTemplate, effectCard);
              if (targets === null) {
                game.log(player, "由【求索】组合出的", effectCard, "没有完成合法目标选择，未使用此牌");
                return false;
              }
              // 若当前 chooseToUse 明确指定了必须涉及的角色，则这些角色必须包含在组合牌目标中；
              // 额外目标仍由“目标模板”规则决定，不用 outer.filterTarget 把它们整体抹掉。
              const required = new Set();
              for (const source of [outer?.target, ...(Array.isArray(outer?.targets) ? outer.targets : [])]) {
                if (source && typeof source.countCards === "function") required.add(source);
              }
              const requiredTargets = Array.from(required);
              if (requiredTargets.length && !requiredTargets.every(target => targets.includes(target))) {
                game.log(player, "由【求索】组合出的", effectCard, "未满足当前询问指定的目标，未使用此牌");
                return false;
              }
              // 无目标牌必须真的不带角色目标；其余情况下保证至少达到模板的最小目标数。
              const range = skill.getTemplateRange(skill.getTargetRuleCard(targetTemplate), player);
              if (range[0] > 0 && targets.length < range[0]) return false;

              player.logSkill("xd_qiusuo", targets);
              // 目标规则已经由模板完全决定。useCard 构造时临时屏蔽“效果牌自身”的 changeTarget，
              // 避免铁索等再次按效果牌自己的目标规则改写本次目标。
              const effectInfo = lib.card[effectCard.name];
              const oldChange = effectInfo?.changeTarget;
              if (effectInfo && oldChange) delete effectInfo.changeTarget;
              let useEvent;
              try {
                useEvent = player.useCard(effectCard, targets, true, "xd_qiusuo");
              } finally {
                if (effectInfo && oldChange) effectInfo.changeTarget = oldChange;
              }
              if (useEvent) {
                useEvent._xd_qiusuo_composite = true;
                useEvent._xd_qiusuo_targetTemplate = get.name(targetTemplate, false) || targetTemplate.name;
                useEvent._xd_qiusuo_effectTemplate = get.name(effectTemplate, false) || effectTemplate.name;
                await useEvent;
                return true;
              }
              return false;
            },
            async doLightning(player, finalWinner, allCards) {
              const suits = [...new Set((allCards || []).map(card => get.suit(card, false)).filter(suit => ["spade", "heart", "club", "diamond"].includes(suit)))];
              const numbers = [...new Set((allCards || []).map(card => Number(get.number(card, false))).filter(num => Number.isFinite(num) && num >= 1 && num <= 13))].sort((a, b) => a - b);
              let suit, number, finalCard = null;

              if (finalWinner === "sky") {
                // 作者最终口径：若“天”成为最终赢家，直接由此刻牌堆顶的那张牌决定最终花色与点数。
                // 这里不建立 judge 事件，因此任何改判技能都不能介入。
                finalCard = get.cards(1)?.[0];
                if (!finalCard) return;
                await game.cardsGotoOrdering(finalCard);
                suit = get.suit(finalCard, false);
                number = Number(get.number(finalCard, false));
                await player.showCards([finalCard], "【求索】：牌堆顶直接决定【闪电】的最终判定结果");
                game.log("#y牌堆顶", "直接决定", player, "的【闪电】最终判定结果为", finalCard);
              } else {
                if (!finalWinner?.isIn() || !suits.length || !numbers.length) return;
                const suitMap = suits.map(item => ({ key: item, label: get.translation(item) }));
                const suitControls = suitMap.map(item => item.label);
                const suitResult = await finalWinner.chooseControl(suitControls)
                  .set("choiceList", suitMap.map(item => "选择花色：" + item.label))
                  .set("prompt", "【求索】：选择【闪电】最终判定结果的花色")
                  .set("ai", () => suitControls[0])
                  .forResult();
                suit = suitMap.find(item => item.label === suitResult?.control)?.key || suits[0];

                const numberMap = numbers.map(item => ({ key: item, label: get.strNumber(item) }));
                const numberControls = numberMap.map(item => item.label);
                const numberResult = await finalWinner.chooseControl(numberControls)
                  .set("choiceList", numberMap.map(item => "选择点数：" + item.label))
                  .set("prompt", "【求索】：选择【闪电】最终判定结果的点数")
                  .set("ai", () => numberControls[0])
                  .forResult();
                number = Number(numberMap.find(item => item.label === numberResult?.control)?.key || numbers[0]);
                game.log(finalWinner, "直接决定了", player, "的【闪电】最终判定结果：", "#y" + get.translation(suit) + get.strNumber(number));
              }

              // 无论最终赢家是角色、屈原自己还是“天”，这里得到的都已经是最终结果，不能改判。
              if (suit === "spade" && number > 1 && number < 10 && player.isIn()) {
                await player.damage(3, "thunder", "nosource");
              }
              if (finalCard) await game.cardsDiscard(finalCard);
            },
            async content(event, trigger, player) {
              const skill = lib.skill.xd_qiusuo;
              const outer = skill.getChooseToUseEvent(event);
              const allCards = [];
              let finalWinner = null;
              let extremeIf = false;

              while (player.isIn()) {
                const modes = skill.getModes(player);
                if (!modes.length) {
                  // 作者确认的极端 IF 彩蛋：屈原始终未负，却已经无人（包括自己）有牌可以继续拼点。
                  // 此时拼点终止，屈原自己成为最终赢家，并仅在这个分支显示隐藏台词。
                  player.popup("得到答案");
                  game.log("天命反侧，何罚何佑？<br><br>天应曰：<br>皇天无私阿兮，览民德焉错辅。<br>终刚强兮不可凌。");
                  finalWinner = player;
                  extremeIf = true;
                  break;
                }
                const route = await skill.chooseRoundRoute(player);
                if (!route) return;
                const compare = await skill.compareOnce(player, route.mode, route.target);
                if (!compare) return;
                if (compare.card1) allCards.push(compare.card1);
                if (compare.card2) allCards.push(compare.card2);
                // 头像上方只反馈【求索】的叙事状态：没输就继续，拼点终止则得到答案。
                if (compare.lost) {
                  player.popup("得到答案");
                  finalWinner = compare.winner;
                  break;
                }
                player.popup("继续求索");
              }

              if (!finalWinner || !player.isIn()) return;
              // 原著版：只有真正“拼点至输”才获得组合并使用一张牌的资格。
              // 极端 IF 是“无法继续拼点而终止”，虽然屈原成为最终赢家，但并未拼输，
              // 因此跳过组合牌阶段，只保留彩蛋台词与由屈原决定最终【闪电】结果。
              const immediate = allCards.filter(card => skill.isImmediate(card));
              if (!extremeIf && immediate.length) {
                // 目标模板只负责“如何选目标”，因此即使某张【杀】已经因次数限制不能再使用，
                // 它仍可提供【杀】的目标规则；只有“效果模板”需要先按当前用牌环境筛掉不可用牌。
                const effectCandidates = immediate.filter(card => {
                  const virtual = skill.makeVirtualEffect(card);
                  return virtual && skill.effectAllowedByOuter(outer, virtual, player);
                });
                if (effectCandidates.length) {
                  const targetTemplate = await skill.chooseTemplateCard(player, immediate, "【求索】：选择一张即时拼点牌，采用其目标规则");
                  const effectTemplate = await skill.chooseTemplateCard(player, effectCandidates, "【求索】：选择一张当前可用的即时拼点牌，采用其牌名与效果");
                  if (targetTemplate && effectTemplate && player.isIn()) {
                    await skill.useComposite(player, outer, targetTemplate, effectTemplate);
                  }
                } else {
                  game.log(player, "本次【求索】的即时拼点牌均不能作为当前可用的效果，因此未组合出牌");
                }
              } else if (!extremeIf) {
                game.log("本次【求索】没有即时拼点牌，因此不视为使用牌");
              }
              if (player.isIn()) await skill.doLightning(player, finalWinner, allCards);
            },
            ai: {
              order: 7.2,
              result: { player: 1 }
            }
          },
          xd_tianwen: {
            // 完全沿用秦宓【天辩】的原生拼点入口：chooseToCompare 在要求屈原选择拼点牌时，
            // 会把拥有 enable:"chooseCard" + onCompare 的技能显示为上方技能按钮。
            // 点【天问】即不选手牌，改用牌堆顶一张牌作为自己的拼点牌。
            enable: "chooseCard",
            group: "xd_tianwen_skyTarget",
            findCompareEvent(start) {
              let current = start || _status.event, guard = 0;
              while (current && guard++ < 16) {
                if (current.name === "chooseToCompare") return current;
                let parent = null;
                try {
                  parent = typeof current.getParent === "function" ? current.getParent() : current.parent;
                } catch (e) {
                  parent = current.parent;
                }
                if (!parent || parent === current) break;
                current = parent;
              }
              return null;
            },
            filter(event, player) {
              // 与本体秦宓【天辩】相同：只有“拼点选牌”窗口才提供技能按钮。
              if (!event || event.type !== "compare" || event.directresult) return false;
              const compare = lib.skill.xd_tianwen.findCompareEvent(event);
              // 已经选择“自己的手牌 vs 牌堆顶”时，禁止再点【天问】形成“牌堆顶 vs 牌堆顶”。
              if (compare?._xd_tianwen_block_selfTop) return false;
              return true;
            },
            onCompare(player) {
              const compare = lib.skill.xd_tianwen.findCompareEvent(_status.event);
              if (compare) {
                compare._xd_tianwen_applied = true;
                compare._xd_tianwen_mode = "skySelf";
              }
              return game.cardsGotoOrdering(get.cards()).cards;
            },
            check(event, player) {
              // 这里只决定 AI 是否点击【天问】；真人始终能在拼点选牌窗口看到按钮。
              return 0;
            },
            subSkill: {
              skyTarget: {
                trigger: { global: "chooseToCompareBegin" },
                direct: true,
                filter(event, player) {
                  if (!event || event.player !== player) return false;
                  if (event.compareMultiple || event.compareMeanwhile) return false;
                  if (event._xd_tianwen_applied || event._xd_qiusuo_inside_target || event._xd_qiusuo_skyTarget) return false;
                  return true;
                },
                async content(event, trigger, player) {
                  const result = await player.chooseBool("【天问】：是否改为与牌堆顶的牌拼点？")
                    .set("ai", () => false)
                    .forResult();
                  if (!result?.bool) return;
                  player.logSkill("xd_tianwen");
                  trigger._xd_tianwen_applied = true;
                  trigger._xd_tianwen_mode = "skyTarget";
                  trigger._xd_tianwen_block_selfTop = true;
                  trigger.target = "cardPile";
                  trigger.compareWithCardPile = true;
                  trigger.compareType = "top";
                }
              }
            }
          },
          // 李斯：欺暗只在李斯自己的回合内接管其他角色的手牌顺序。
          // 内部顺序用 sortHandcardOL 落地；观察动画只展示公开信息（暗牌始终是牌背），
          // 让李斯能追踪“哪张从哪里移动到哪里”，而不是瞬间得到一个最终排列。
          xd_qian: {
            locked: true,
            forced: true,
            group: ["xd_qian_begin", "xd_qian_gain", "xd_qian_loss", "xd_qian_end"],
            active(player) {
              return !!player?.isIn?.() && _status.currentPhase === player && player.hasSkill("xd_qian", null, false);
            },
            state(player) {
              if (!player._xd_qian_state) player._xd_qian_state = { edges: new Map() };
              if (!(player._xd_qian_state.edges instanceof Map)) player._xd_qian_state.edges = new Map();
              return player._xd_qian_state;
            },
            clearState(player) {
              delete player._xd_qian_state;
            },
            cleanup(player) {
              for (const target of game.players.concat(game.dead || [])) {
                if (target !== player) lib.skill.xd_qian.removeSortLock(player, target);
              }
              lib.skill.xd_qian.clearState(player);
            },
            onremove(player) {
              lib.skill.xd_qian.cleanup(player);
            },
            sortNumber(card) {
              const num = Number(get.number(card));
              return Number.isFinite(num) ? num : 99;
            },
            stableOrder(cards) {
              return cards.map((card, index) => ({ card, index, num: lib.skill.xd_qian.sortNumber(card) }))
                .sort((a, b) => a.num - b.num || a.index - b.index)
                .map(item => item.card);
            },
            sameOrder(a, b) {
              return a.length === b.length && a.every((card, index) => b[index] === card);
            },
            rememberEdges(player, target) {
              if (!target?.isIn?.() || target === player) return;
              const hand = target.getCards("h").slice();
              lib.skill.xd_qian.state(player).edges.set(target, hand.length ? [hand[0], hand[hand.length - 1]] : []);
            },
            rememberAllEdges(player) {
              const state = lib.skill.xd_qian.state(player);
              for (const target of game.players) {
                if (target === player || !target.isIn()) continue;
                lib.skill.xd_qian.rememberEdges(player, target);
              }
              for (const target of [...state.edges.keys()]) {
                if (!target?.isIn?.() || target === player) state.edges.delete(target);
              }
            },
            lockKey(player) {
              return "xd_qian_lock_" + player.playerid;
            },
            addSortLock(player, target) {
              if (!target || target === player) return;
              const key = lib.skill.xd_qian.lockKey(player);
              if (typeof target.addAdditionalSkill === "function") {
                target.addAdditionalSkill(key, "xd_qian_nosort");
              } else if (!target.hasSkill("xd_qian_nosort")) {
                target.storage.xd_qian_nosort_fallback ??= [];
                if (!target.storage.xd_qian_nosort_fallback.includes(key)) target.storage.xd_qian_nosort_fallback.push(key);
                target.addSkill("xd_qian_nosort");
              }
            },
            removeSortLock(player, target) {
              if (!target) return;
              const key = lib.skill.xd_qian.lockKey(player);
              if (typeof target.removeAdditionalSkill === "function") {
                target.removeAdditionalSkill(key);
                return;
              }
              const list = target.storage.xd_qian_nosort_fallback;
              if (!Array.isArray(list)) return;
              target.storage.xd_qian_nosort_fallback = list.filter(item => item !== key);
              if (!target.storage.xd_qian_nosort_fallback.length) {
                delete target.storage.xd_qian_nosort_fallback;
                if (target.hasSkill("xd_qian_nosort")) target.removeSkill("xd_qian_nosort");
              }
            },
            // 本体 sortHandcard()/sortHandcardOL() 会先检查 noSortCard，而且会依据玩家自己的
            // sort_card 设置把牌分到 handcards1/handcards2。对普通“整理手牌”这没问题，
            // 但【欺暗】要求全体手牌只有一个确定的左→右点数序，不能让本地排序设置改变规则结果。
            syncHandOrder(target) {
              if (!_status.connectMode || !target?.isIn?.()) return;
              const ids = target.getCards("h").map(card => card.cardid);
              if (game.online && typeof game.send === "function") game.send("syncHandcard", ids);
              else if (typeof game.syncHandcard === "function") game.syncHandcard(target, ids);
            },
            forceSortHandcardLocal(target, sort) {
              if (!target?.node?.handcards1 || !Array.isArray(sort) || !sort.length) return false;
              const hs = target.getCards("h").slice();
              if (!hs.length || hs.length !== sort.length || !sort.every(card => hs.includes(card))) return false;
              hs.sort((a, b) => sort.indexOf(a) - sort.indexOf(b));

              const cards1 = [];
              const cards2 = !get.is.singleHandcard() ? [] : null;
              target.node.handcards1.style.visibility = "hidden";
              if (target.node.handcards2) target.node.handcards2.style.visibility = "hidden";
              for (const card of hs) {
                const side = lib.config.sort_card(card);
                if (side < 0 && cards2) cards2.unshift(card);
                else cards1.unshift(card);
              }
              target.node.handcards1.prepend(...cards1);
              if (cards2 && target.node.handcards2) target.node.handcards2.prepend(...cards2);
              target.node.handcards1.style.visibility = "visible";
              if (target.node.handcards2) target.node.handcards2.style.visibility = "visible";
              if (target === game.me && typeof ui.updatehl === "function") ui.updatehl();
              return true;
            },
            forceSingleLaneOrder(target, order) {
              if (!target?.node?.handcards1 || !Array.isArray(order) || !order.length) return false;
              const current = target.getCards("h").slice();
              if (current.length !== order.length || !order.every(card => current.includes(card))) return false;
              const h1 = target.node.handcards1;
              const h2 = target.node.handcards2;
              h1.style.visibility = "hidden";
              if (h2) h2.style.visibility = "hidden";

              // 先按直观 DOM 顺序放入；随后读取引擎自己的 getCards('h') 做后验校验。
              // 若该布局/版本的读取方向相反，再反向放一次。规则结果由校验决定，不再硬编码“必反转”。
              h1.append(...order);
              let ok = lib.skill.xd_qian.sameOrder(target.getCards("h").slice(), order);
              if (!ok) {
                h1.append(...order.slice().reverse());
                ok = lib.skill.xd_qian.sameOrder(target.getCards("h").slice(), order);
              }

              h1.style.visibility = "visible";
              if (h2) h2.style.visibility = "visible";
              if (target === game.me && typeof ui.updatehl === "function") ui.updatehl();
              return ok;
            },
            applyOrder(target, order) {
              if (!target?.isIn?.() || !Array.isArray(order) || order.length < 2) return false;
              let current = target.getCards("h").slice();
              if (current.length !== order.length || !order.every(card => current.includes(card))) return false;
              if (lib.skill.xd_qian.sameOrder(current, order)) return true;

              // 第一层：沿用本体当前 sortHandcard 的落位结构，但不相信固定方向。
              // 先试历史版本中常见的“传入反序”，读回结果；不对再试正序。
              lib.skill.xd_qian.forceSortHandcardLocal(target, order.slice().reverse());
              current = target.getCards("h").slice();
              if (!lib.skill.xd_qian.sameOrder(current, order)) {
                lib.skill.xd_qian.forceSortHandcardLocal(target, order);
                current = target.getCards("h").slice();
              }

              // 第二层兜底：若玩家的 sort_card 把手牌拆成两个容器，跨容器后就不存在唯一的
              // “整副手牌左→右序”。【欺暗】回合内暂时把这些牌收进同一手牌容器，并以后验
              // 校验决定 DOM 方向。这样规则顺序不受个人“整理手牌”设置影响。
              if (!lib.skill.xd_qian.sameOrder(current, order)) {
                lib.skill.xd_qian.forceSingleLaneOrder(target, order);
                current = target.getCards("h").slice();
              }

              const ok = lib.skill.xd_qian.sameOrder(current, order);
              if (ok) lib.skill.xd_qian.syncHandOrder(target);
              return ok;
            },
            async wait(ms) {
              if (typeof setTimeout !== "function") return;
              await new Promise(resolve => setTimeout(resolve, ms));
            },
            createObserverCard(card, target, options = {}) {
              const shown = lib.xd_utils.isShownHandCard(card, target);
              let node = null;
              try {
                if (typeof game.createFakeCards === "function") {
                  // 暗置牌必须直接调用无名杀自己的 blank fake-card 牌背；
                  // 已明置牌则生成正常 fake-card，保留本体/美化包的卡面样式。
                  node = game.createFakeCards(card, !shown)?.[0] || null;
                }
              } catch (e) {}
              if (!node) {
                try { node = card.cloneNode(true); } catch (e) {}
              }
              if (!node && typeof ui.create?.card === "function") {
                try { node = ui.create.card(); } catch (e) {}
              }
              if (!node) return null;

              if (shown) node.classList?.remove("infohidden", "infoflip");
              else node.classList?.add("infohidden", "infoflip");
              node.classList?.remove("selected", "selectable", "glow", "target");
              node.setAttribute?.("aria-hidden", "true");

              const width = Math.max(42, Number(options.width) || 68);
              const height = Math.round(width * 1.4);
              Object.assign(node.style, {
                position: "relative",
                left: "0px",
                top: "0px",
                right: "auto",
                bottom: "auto",
                width: width + "px",
                height: height + "px",
                minWidth: width + "px",
                maxWidth: width + "px",
                minHeight: height + "px",
                maxHeight: height + "px",
                flex: "0 0 " + width + "px",
                margin: "0",
                opacity: "1",
                display: "block",
                pointerEvents: "none",
                transform: "none",
                transformOrigin: "center center",
                transition: "none",
                willChange: "transform,opacity",
                boxSizing: "border-box",
              });
              return node;
            },
            createObserverStage(target, text, cards, options = {}) {
              if (typeof document === "undefined" || !ui.window) return null;
              const count = Math.max(1, cards?.length || 1);
              const viewport = Math.max(360, Math.min(window.innerWidth || 1000, 1100));
              const usable = Math.min(viewport * 0.88, 920);
              const gap = count > 12 ? 3 : count > 8 ? 5 : 8;
              const width = Math.max(42, Math.min(70, Math.floor((usable - gap * Math.max(0, count - 1)) / count)));

              const root = document.createElement("div");
              root.className = "xd-qian-observer";
              // 不再绘制整块黑色说明框。牌本身放在画面中部偏下，尽量避开本体提示文字。
              root.style.cssText = "position:fixed;left:50%;top:57%;transform:translate(-50%,-50%);z-index:30;width:min(88vw,920px);height:auto;pointer-events:none;overflow:visible;";
              const row = document.createElement("div");
              row.style.cssText = "display:flex;gap:" + gap + "px;align-items:center;justify-content:center;width:100%;overflow:visible;min-height:" + Math.round(width * 1.4) + "px;";
              const caption = document.createElement("div");
              caption.textContent = text;
              // 说明单独放在牌列下方，固定为单行，不再因手牌少而缩成四五个字一行。
              caption.style.cssText = "position:absolute;left:50%;top:calc(100% + 10px);transform:translateX(-50%);max-width:88vw;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding:5px 12px;border-radius:12px;background:rgba(18,20,28,.78);color:white;font-size:15px;line-height:1.3;text-shadow:0 1px 2px #000;box-shadow:0 2px 8px rgba(0,0,0,.30);";
              root.append(row, caption);
              ui.window.appendChild(root);
              return { root, row, caption, width };
            },
            async animateOrder(observer, target, before, after, options = {}) {
              if (observer !== game.me || typeof document === "undefined" || !ui.window) return;
              if (!Array.isArray(before) || !Array.isArray(after) || !before.length || lib.skill.xd_qian.sameOrder(before, after)) return;
              const current = target.getCards("h");
              if (!before.every(card => current.includes(card))) return;

              const stage = lib.skill.xd_qian.createObserverStage(
                target,
                "【欺暗】" + get.translation(target) + "整理手牌" + (options.reason ? " · " + options.reason : ""),
                before,
                options
              );
              if (!stage) return;
              const { root, row, width } = stage;
              const newCards = new Set(options.newCards || []);
              const nodes = new Map();
              for (const card of before) {
                const node = lib.skill.xd_qian.createObserverCard(card, target, { width });
                if (!node) continue;
                if (newCards.has(card)) {
                  const badge = document.createElement("div");
                  badge.textContent = "新";
                  badge.style.cssText = "position:absolute;right:-5px;top:-7px;min-width:19px;height:19px;line-height:19px;text-align:center;border-radius:10px;background:rgba(245,245,245,.96);color:#222;font-size:11px;font-weight:bold;box-shadow:0 1px 4px #000;z-index:8;pointer-events:none;";
                  node.appendChild(badge);
                }
                nodes.set(card, node);
                row.appendChild(node);
              }
              if (!nodes.size) {
                root.remove();
                return;
              }

              await lib.skill.xd_qian.wait(260);
              const first = new Map();
              for (const [card, node] of nodes) first.set(card, node.getBoundingClientRect());
              for (const card of after) {
                const node = nodes.get(card);
                if (node) row.appendChild(node);
              }
              const last = new Map();
              for (const [card, node] of nodes) last.set(card, node.getBoundingClientRect());
              for (const [card, node] of nodes) {
                const a = first.get(card), b = last.get(card);
                node.style.transform = "translate(" + (a.left - b.left) + "px," + (a.top - b.top) + "px)";
              }
              void row.offsetWidth;
              for (const node of nodes.values()) {
                node.style.transition = "transform 760ms cubic-bezier(.2,.75,.2,1)";
                node.style.transform = "translate(0,0)";
              }
              await lib.skill.xd_qian.wait(920);
              root.remove();
            },
            async animateRemoval(observer, target, before, removed) {
              if (observer !== game.me || typeof document === "undefined" || !ui.window) return;
              const removing = new Set(removed || []);
              if (!before?.length || !before.some(card => removing.has(card))) return;

              const stage = lib.skill.xd_qian.createObserverStage(
                target,
                "【欺明】" + get.translation(target) + "重铸暗置牌 · 观察抽出位置",
                before
              );
              if (!stage) return;
              const { root, row, width } = stage;
              const nodes = new Map();
              for (const card of before) {
                const node = lib.skill.xd_qian.createObserverCard(card, target, { width });
                if (!node) continue;
                nodes.set(card, node);
                row.appendChild(node);
              }
              if (!nodes.size) {
                root.remove();
                return;
              }

              await lib.skill.xd_qian.wait(240);
              for (const [card, node] of nodes) {
                if (!removing.has(card)) continue;
                node.style.transition = "transform 520ms ease, opacity 520ms ease";
                node.style.transform = "translateY(-48px) scale(.94)";
                node.style.opacity = "0";
              }
              await lib.skill.xd_qian.wait(650);
              root.remove();
            },
            async sortTarget(player, target, options = {}) {
              if (!lib.skill.xd_qian.active(player) || !target?.isIn?.() || target === player) return false;
              const before = target.getCards("h").slice();
              if (before.length < 2) {
                lib.skill.xd_qian.rememberEdges(player, target);
                return false;
              }
              const after = lib.skill.xd_qian.stableOrder(before);
              if (lib.skill.xd_qian.sameOrder(before, after)) {
                lib.skill.xd_qian.rememberEdges(player, target);
                return false;
              }
              await lib.skill.xd_qian.animateOrder(player, target, before, after, options);
              // 动画期间没有开放玩家操作；结束后一次性把真实手牌顺序落到最终状态。
              lib.skill.xd_qian.applyOrder(target, after);
              lib.xd_utils.recordCaiyanHandState?.(target);
              lib.skill.xd_qian.rememberEdges(player, target);
              return true;
            },
            getLostCards(event, target) {
              let cards = [];
              try {
                if (typeof event.getl === "function") {
                  const info = event.getl(target);
                  if (Array.isArray(info?.hs)) cards.push(...info.hs);
                  else if (Array.isArray(info?.cards)) cards.push(...info.cards);
                }
              } catch (e) {}
              if (event.player === target && Array.isArray(event.cards)) cards.push(...event.cards);
              return [...new Set(cards)];
            },
            lostEdge(event, player, target) {
              const edges = lib.skill.xd_qian.state(player).edges.get(target) || [];
              if (!edges.length) return false;
              const lost = lib.skill.xd_qian.getLostCards(event, target);
              return lost.some(card => edges.includes(card));
            },
            affectedLosers(event, player) {
              const result = [];
              for (const target of game.players) {
                if (target === player || !target.isIn()) continue;
                if (lib.skill.xd_qian.lostEdge(event, player, target)) result.push(target);
              }
              return result;
            },
            gainedTargets(event, player) {
              const result = [];
              for (const target of game.players) {
                if (target === player || !target.isIn()) continue;
                let cards = [];
                try {
                  if (typeof event.getg === "function") cards = event.getg(target) || [];
                } catch (e) {}
                if (!cards.length && event.player === target && Array.isArray(event.cards)) cards = event.cards;
                const hand = target.getCards("h");
                cards = [...new Set(cards.filter(card => hand.includes(card)))];
                if (cards.length) result.push({ target, cards });
              }
              return result;
            },
            subSkill: {
              begin: {
                charlotte: true,
                forced: true,
                popup: false,
                firstDo: true,
                priority: 1000,
                trigger: { player: "phaseBegin" },
                async content(event, trigger, player) {
                  lib.skill.xd_qian.state(player).edges.clear();
                  const targets = game.players.filter(target => target !== player && target.isIn());
                  for (const target of targets) lib.skill.xd_qian.addSortLock(player, target);
                  // 依座次逐人整理；同点数保持原相对顺序。
                  for (const target of targets) {
                    await lib.skill.xd_qian.sortTarget(player, target, { reason: "回合开始" });
                  }
                  lib.skill.xd_qian.rememberAllEdges(player);
                }
              },
              gain: {
                charlotte: true,
                forced: true,
                popup: false,
                trigger: { global: ["gainAfter", "loseAsyncAfter"] },
                filter(event, player) {
                  return lib.skill.xd_qian.active(player) && lib.skill.xd_qian.gainedTargets(event, player).length > 0;
                },
                async content(event, trigger, player) {
                  const items = lib.skill.xd_qian.gainedTargets(trigger, player);
                  for (const item of items) {
                    await lib.skill.xd_qian.sortTarget(player, item.target, { reason: "新牌插入", newCards: item.cards });
                    lib.skill.xd_qian.rememberEdges(player, item.target);
                  }
                }
              },
              loss: {
                charlotte: true,
                forced: true,
                popup: false,
                trigger: { global: ["loseAfter", "loseAsyncAfter"] },
                filter(event, player) {
                  return lib.skill.xd_qian.active(player) && lib.skill.xd_qian.affectedLosers(event, player).length > 0;
                },
                async content(event, trigger, player) {
                  const targets = lib.skill.xd_qian.affectedLosers(trigger, player);
                  for (const target of targets) {
                    player.logSkill("xd_qian", target);
                    await player.draw(1);
                    // 一次失牌事件即使同时失去左右两张边缘牌，也只结算一次。
                    lib.skill.xd_qian.rememberEdges(player, target);
                  }
                  // 未触发摸牌的失牌也可能改变边缘；统一刷新，避免后续拿旧边缘重复判断。
                  lib.skill.xd_qian.rememberAllEdges(player);
                }
              },
              end: {
                charlotte: true,
                forced: true,
                popup: false,
                lastDo: true,
                trigger: { player: "phaseAfter" },
                content(event, trigger, player) {
                  lib.skill.xd_qian.cleanup(player);
                }
              },
            }
          },
          xd_qian_nosort: {
            charlotte: true,
            popup: false,
            ai: { noSortCard: true }
          },
          xd_qiming: {
            locked: true,
            forced: true,
            trigger: { player: "useCardAfter" },
            filter(event, player) {
              return Array.isArray(event.targets) && event.targets.some(target => target?.isIn?.() && lib.xd_utils.getUnshownHandCards(target).length > 0);
            },
            async chooseHidden(player, target) {
              if (target === player) {
                const result = await player.chooseCard({
                  position: "h",
                  forced: true,
                  selectCard: 1,
                  prompt: "【欺明】：明置你的一张暗置手牌",
                  filterCard(card, current) {
                    return !lib.xd_utils.isShownHandCard(card, current);
                  },
                  ai(card) {
                    return 6 - get.value(card);
                  }
                }).forResult();
                return result?.bool ? result.cards?.[0] : null;
              }
              const next = player.choosePlayerCard(target, "h", true);
              next.set("prompt", "【欺明】：明置" + get.translation(target) + "的一张暗置手牌");
              next.set("selectButton", 1);
              next.set("xd_qiming_target", target);
              next.set("filterButton", function (button) {
                const current = get.event().xd_qiming_target;
                return !!button?.link && !!current && !lib.xd_utils.isShownHandCard(button.link, current);
              });
              const result = await next.forResult();
              return result?.bool ? result.links?.[0] : null;
            },
            async recastDark(player, target) {
              const candidates = lib.xd_utils.getUnshownHandCards(target).filter(card => !target.canRecast || target.canRecast(card));
              if (!candidates.length) return;
              const result = await target.chooseCard({
                position: "h",
                forced: true,
                selectCard: 1,
                prompt: "【欺明】：请选择一张暗置手牌重铸",
                filterCard(card, current) {
                  if (lib.xd_utils.isShownHandCard(card, current)) return false;
                  return !current.canRecast || current.canRecast(card);
                },
                ai(card) {
                  return 7 - get.value(card);
                }
              }).forResult();
              if (!result?.bool || !result.cards?.length) return;
              const chosen = result.cards[0];
              const before = target.getCards("h").slice();
              await lib.skill.xd_qian.animateRemoval(player, target, before, [chosen]);
              await target.recast([chosen]);
            },
            async resolveTarget(player, target, usedNumber) {
              if (!target?.isIn?.() || !lib.xd_utils.getUnshownHandCards(target).length) return;
              const chosen = await lib.skill.xd_qiming.chooseHidden(player, target);
              if (!chosen || !target.getCards("h").includes(chosen) || lib.xd_utils.isShownHandCard(chosen, target)) return;
              const shown = await lib.xd_utils.revealHandCards(target, [chosen], "visible_xd_qiming", "因【欺明】明置");
              if (!shown.length) return;
              const card = shown[0];
              const targetNumber = Number(get.number(card, target));
              if (Number.isFinite(usedNumber) && Number.isFinite(targetNumber) && targetNumber === usedNumber) {
                if (target !== player && target.getCards("h").includes(card)) await player.gain(card, target, "giveAuto");
                return;
              }
              await lib.skill.xd_qiming.recastDark(player, target);
            },
            async content(event, trigger, player) {
              // useCardAfter 的 targets 保留本次用牌的目标顺序；多目标逐个分别结算【欺明】。
              const targets = [...new Set((trigger.targets || []).filter(target => target?.isIn?.()))];
              if (!targets.length) return;
              const usedNumber = Number(get.number(trigger.card, player));
              for (const target of targets) {
                if (!target.isIn()) continue;
                await lib.skill.xd_qiming.resolveTarget(player, target, usedNumber);
              }
            }
          },
          // 王衍
          xd_yangkuang: {
            direct: true,
            trigger: {
              player: ["recoverEnd", "gainAfter"],
              global: "loseAsyncAfter"
            },
            getGainedHandCards(event, player) {
              let cards = [];
              try {
                if (typeof event.getg === "function") cards = event.getg(player) || [];
              } catch (e) {}
              if (!cards.length && event.player === player && Array.isArray(event.cards)) cards = event.cards;
              const hand = player.getCards("h");
              return [...new Set(cards.filter(card => hand.includes(card)))];
            },
            filter(event, player) {
              // “当前回合角色”必须实际存在；同时避免开局发牌被误判为脱离空手牌。
              const current = _status.currentPhase;
              if (!current || !current.isIn()) return false;
              if (event.name === "recover") {
                return Number(event.num) > 0 && player.isHealthy();
              }
              if (event.name === "gain" || event.name === "loseAsync") {
                const gained = lib.skill.xd_yangkuang.getGainedHandCards(event, player);
                if (!gained.length) return false;
                // 当前全部手牌都来自这次获得，说明本次获得前恰为0手牌。
                return player.countCards("h") === gained.length;
              }
              return false;
            },
            async content(event, trigger, player) {
              const current = _status.currentPhase;
              if (!current || !current.isIn()) return;
              const same = current === player;
              const prompt = same
                ? "是否发动【阳狂】，自摸两张牌并连续视为使用两张【酒】？"
                : "是否发动【阳狂】，与" + get.translation(current) + "各摸一张牌并各视为使用【酒】？";
              const result = await player.chooseBool(prompt).set("ai", function () {
                const player = get.player();
                const target = get.event().xd_yangkuang_target;
                return target === player || get.attitude(player, target) >= 0;
              }).set("xd_yangkuang_target", current).forResult();
              if (!result?.bool) return;

              player.logSkill("xd_yangkuang", same ? undefined : current);
              // “你”与“当前回合角色”分别执行；两者为同一人时也保留为两个独立事件。
              await player.draw();
              if (!current.isIn()) return;
              await current.draw();

              const drink = async target => {
                if (!target?.isIn()) return;
                const next = target.useCard({ name: "jiu", isCard: true }, target, false);
                next.skill = "xd_yangkuang";
                await next;
              };
              await drink(player);
              if (!current.isIn()) return;
              await drink(current);
            }
          },
          xd_cihuang: {
            direct: true,
            trigger: {
              global: ["eventNeutralized", "shaMiss"]
            },
            getRoundUseCount(player) {
              let count = 0;
              const history = Array.isArray(player.actionHistory) ? player.actionHistory : [];
              for (let i = history.length - 1; i >= 0; i--) {
                const info = history[i];
                if (Array.isArray(info?.useCard)) count += info.useCard.length;
                if (info?.isRound) break;
              }
              return count;
            },
            getOriginalRuleCard(card) {
              if (!card) return null;
              const name = typeof card.name === "string" && card.name ? card.name : get.name(card);
              if (!name) return null;
              return {
                name,
                nature: card.nature,
                isCard: true
              };
            },
            targetCountAtMostOne(card) {
              const ruleCard = lib.skill.xd_cihuang.getOriginalRuleCard(card);
              if (!ruleCard) return false;
              const info = lib.card[ruleCard.name] || get.info(ruleCard);
              if (!info) return false;
              if (info.notarget) return true;
              // 本体常用 -1 + toself 表示固定只以自己为目标，实际目标数仍为1。
              if (info.selectTarget === -1 && info.toself) return true;
              let select;
              try {
                select = get.select(info.selectTarget);
              } catch (e) {
                return false;
              }
              if (!Array.isArray(select) || select.length < 2) return true;
              const max = Number(select[1]);
              if (max === -1) return false;
              return Number.isFinite(max) && max <= 1;
            },
            isImmediate(card) {
              const type = get.type(card, null, false);
              return type === "basic" || type === "trick";
            },
            getList(player, target) {
              if (!target?.isIn()) return [];
              const materials = player.getCards("he").filter(card => lib.skill.xd_cihuang.targetCountAtMostOne(card));
              if (!materials.length) return [];
              return get.inpileVCardList(info => {
                const card = get.autoViewAs({
                  name: info[2],
                  nature: info[3],
                  isCard: true
                }, "unsure");
                if (!lib.skill.xd_cihuang.isImmediate(card) || !lib.skill.xd_cihuang.targetCountAtMostOne(card)) return false;
                return materials.some(material => {
                  try {
                    return player.canUse(get.autoViewAs(card, [material]), target, false);
                  } catch (e) {
                    return false;
                  }
                });
              });
            },
            filter(event, player) {
              if (event.type !== "card") return false;
              const user = event.player;
              if (!user?.isIn()) return false;
              // 第一者：被抵消牌的实际目标数须≤1。沿用本体 eventNeutralized/shaMiss 的 targets。
              if (!Array.isArray(event.targets) || event.targets.length > 1) return false;
              // 检查的是发动【雌黄】之前，王衍本轮已经使用牌的次数。
              if (lib.skill.xd_cihuang.getRoundUseCount(player) > 1) return false;
              return lib.skill.xd_cihuang.getList(player, user).length > 0;
            },
            async content(event, trigger, player) {
              const skill = lib.skill.xd_cihuang;
              const target = trigger.player;
              const list = skill.getList(player, target);
              if (!list.length || !target?.isIn()) return;

              if (_status.connectMode) {
                game.broadcastAll(function () {
                  _status.noclearcountdown = true;
                });
              }
              const picked = await player.chooseButton([
                get.prompt("xd_cihuang", target),
                '<div class="text center">选择要将一张牌当作的即时牌，并对' + get.translation(target) + "使用</div>",
                [list, "vcard"]
              ]).set("ai", function (button) {
                const player = get.player();
                const target = get.event().xd_cihuang_target;
                const card = {
                  name: button.link[2],
                  nature: button.link[3],
                  isCard: true
                };
                return get.effect(target, card, player, player);
              }).set("xd_cihuang_target", target).forResult();

              if (!picked?.bool || !picked.links?.length) {
                if (_status.connectMode) {
                  game.broadcastAll(function () {
                    delete _status.noclearcountdown;
                    game.stopCountChoose();
                  });
                }
                return;
              }

              const link = picked.links[0];
              const vcard = {
                name: link[2],
                nature: link[3],
                isCard: true
              };
              const material = await player.chooseCard(
                "he",
                "雌黄：将一张目标数不大于1的牌当" + get.translation(vcard) + "对" + get.translation(target) + "使用",
                function (card, player) {
                  const skill = lib.skill.xd_cihuang;
                  if (!skill.targetCountAtMostOne(card)) return false;
                  const virtual = get.autoViewAs(get.event().xd_cihuang_vcard, [card]);
                  try {
                    return player.canUse(virtual, get.event().xd_cihuang_target, false);
                  } catch (e) {
                    return false;
                  }
                }
              ).set("xd_cihuang_vcard", vcard).set("xd_cihuang_target", target).set("ai", function (card) {
                const player = get.player();
                const target = get.event().xd_cihuang_target;
                const virtual = get.autoViewAs(get.event().xd_cihuang_vcard, [card]);
                const effect = get.effect(target, virtual, player, player);
                if (effect <= 0) return 0;
                return effect + 6 - get.value(card, player);
              }).forResult();

              if (_status.connectMode) {
                game.broadcastAll(function () {
                  delete _status.noclearcountdown;
                  game.stopCountChoose();
                });
              }
              if (!material?.bool || !material.cards?.length || !target.isIn()) return;

              player.logSkill("xd_cihuang", target);
              await player.useCard(get.autoViewAs(vcard, material.cards), material.cards, false, target, "xd_cihuang");
            }
          },
          xd_sanku: {
            locked: true,
            forced: true,
            trigger: {
              player: "dying"
            },
            async content(event, trigger, player) {
              await player.loseMaxHp();
              const num = player.maxHp - player.hp;
              if (num > 0) await player.recover(num);
            },
            ai: {
              halfneg: true
            }
          },
          // 祖逖
          xd_jiji: {
            enable: "chooseToUse",
            mark: true,
            marktext: "楫",
            init(player) {
              lib.skill.xd_jiji.getState(player);
              player.markSkill("xd_jiji");
            },
            getState(player) {
              let state = player.storage.xd_jiji_state;
              if (!state || typeof state !== "object") {
                state = player.storage.xd_jiji_state = {
                  lines: [0, 0, 0],
                  turnKey: null,
                  turnUses: 0,
                  drawTurn: null
                };
              }
              if (!Array.isArray(state.lines)) state.lines = [0, 0, 0];
              state.lines = [0, 1, 2].map(i => Math.max(0, Math.floor(Number(state.lines[i]) || 0)));
              state.turnUses = Math.max(0, Math.floor(Number(state.turnUses) || 0));
              return state;
            },
            sync(player) {
              if (typeof player.syncStorage === "function") player.syncStorage("xd_jiji_state");
              player.markSkill("xd_jiji");
            },
            getTurnKey() {
              const phase = _status.currentPhase;
              return String(Number(game.phaseNumber) || 0) + ":" + (phase?.playerid || "none");
            },
            getTurnState(player) {
              const skill = lib.skill.xd_jiji, state = skill.getState(player), key = skill.getTurnKey();
              if (state.turnKey !== key) {
                state.turnKey = key;
                state.turnUses = 0;
              }
              return state;
            },
            addLineCount(player, index) {
              const state = lib.skill.xd_jiji.getState(player);
              state.lines[index] = Math.max(0, Math.floor(Number(state.lines[index]) || 0)) + 1;
              lib.skill.xd_jiji.sync(player);
            },
            getX(player) {
              return lib.xd_utils.getMovedOutCards(player).length;
            },
            isImmediate(card) {
              const type = get.type(card, null, false);
              return type === "basic" || type === "trick";
            },
            sameName(card, name, player) {
              return !!card && !!name && get.name(card, player) === name;
            },
            getDiscardedImmediateCards(event) {
              const skill = lib.skill.xd_jiji;
              let cards = [];
              if (event && typeof event.getd === "function") {
                try {
                  const got = event.getd();
                  if (Array.isArray(got)) cards.push(...got);
                } catch (e) {}
              }
              if (!cards.length && event) {
                const raw = [];
                if (Array.isArray(event.cards)) raw.push(...event.cards);
                if (Array.isArray(event.cards2)) raw.push(...event.cards2);
                cards.push(...raw.filter(card => {
                  try {
                    return get.position(card, true) === "d" || card?.parentNode === ui.discardPile;
                  } catch (e) {
                    return card?.parentNode === ui.discardPile;
                  }
                }));
              }
              return [...new Set(cards)].filter(card => skill.isImmediate(card));
            },
            hasSameNameOwnCard(player, name) {
              if (player.getCards("he").some(card => lib.skill.xd_jiji.sameName(card, name, player))) return true;
              return lib.xd_utils.getMovedOutCards(player).some(card => lib.skill.xd_jiji.sameName(card, name, player));
            },
            canUseThird(player) {
              const state = lib.skill.xd_jiji.getState(player);
              const min = Math.min(...state.lines);
              return state.lines[2] === min && lib.xd_utils.getMovedOutCards(player).length > 0;
            },
            toVirtual(card, player) {
              const virtual = {
                name: get.name(card, player),
                suit: get.suit(card, player),
                number: get.number(card, player),
                isCard: true
              };
              const nature = get.nature(card, player);
              if (nature) virtual.nature = nature;
              return virtual;
            },
            getLegalMoved(event, player) {
              const skill = lib.skill.xd_jiji;
              if (!skill.canUseThird(player) || !event || event.responded || typeof event.filterCard !== "function") return [];
              return lib.xd_utils.getMovedOutCards(player).filter(card => {
                try {
                  return !!event.filterCard(skill.toVirtual(card, player), player, event);
                } catch (e) {
                  return false;
                }
              });
            },
            isJijiUse(event) {
              const name = event?.skill;
              if (name === "xd_jiji" || name === "xd_jiji_backup") return true;
              if (!name) return false;
              try {
                return get.info(name)?.sourceSkill === "xd_jiji";
              } catch (e) {
                return false;
              }
            },
            filter(event, player) {
              return lib.skill.xd_jiji.getLegalMoved(event, player).length > 0;
            },
            chooseButton: {
              dialog(event, player) {
                const cards = lib.skill.xd_jiji.getLegalMoved(event, player);
                return ui.create.dialog("击楫：选择要视为使用的移出牌", [cards, "card"]);
              },
              filter(button, player) {
                const event = _status.event.getParent();
                if (!button?.link || !event || typeof event.filterCard !== "function") return false;
                if (!lib.xd_utils.getMovedOutCards(player).includes(button.link)) return false;
                try {
                  return !!event.filterCard(lib.skill.xd_jiji.toVirtual(button.link, player), player, event);
                } catch (e) {
                  return false;
                }
              },
              check(button) {
                const player = get.player();
                return player.getUseValue(lib.skill.xd_jiji.toVirtual(button.link, player));
              },
              backup(links) {
                const player = get.player();
                const card = links[0];
                return {
                  filterCard: () => false,
                  selectCard: -1,
                  popname: true,
                  log: false,
                  sourceSkill: "xd_jiji",
                  viewAs: lib.skill.xd_jiji.toVirtual(card, player)
                };
              },
              prompt(links) {
                const player = get.player();
                const card = links[0];
                return "发动【击楫】，视为使用移出牌" + get.translation(lib.skill.xd_jiji.toVirtual(card, player));
              }
            },
            hiddenCard(player, name) {
              const event = _status.event;
              if (!event || event.name !== "chooseToUse") return false;
              return lib.skill.xd_jiji.getLegalMoved(event, player).some(card => get.name(card, player) === name);
            },
            intro: {
              markcount(storage, player) {
                return lib.skill.xd_jiji.getX(player);
              },
              mark(dialog, content, player) {
                const skill = lib.skill.xd_jiji, state = skill.getState(player), cards = lib.xd_utils.getMovedOutCards(player);
                dialog.addText("移出牌数X=" + cards.length);
                dialog.addText("三行发动次数：" + state.lines[0] + " / " + state.lines[1] + " / " + state.lines[2]);
                dialog.addText("第三行当前" + (state.lines[2] === Math.min(...state.lines) ? "满足‘次数最少’" : "不满足‘次数最少’"));
                if (cards.length) {
                  dialog.addText("移出牌");
                  dialog.addAuto(cards);
                } else {
                  dialog.addText("当前没有移出牌");
                }
              }
            },
            group: ["xd_jiji_discard", "xd_jiji_count", "xd_jiji_consume"],
            subSkill: {
              backup: {},
              discard: {
                trigger: {
                  global: ["loseAfter", "loseAsyncAfter", "cardsDiscardAfter"]
                },
                direct: true,
                filter(event, player) {
                  const skill = lib.skill.xd_jiji;
                  return skill.getDiscardedImmediateCards(event).some(card => {
                    const name = get.name(card, false);
                    return skill.hasSameNameOwnCard(player, name);
                  });
                },
                async content(event, trigger, player) {
                  const skill = lib.skill.xd_jiji, u = lib.xd_utils;
                  const entered = skill.getDiscardedImmediateCards(trigger);
                  for (const basis of entered) {
                    if (!player.isIn() || !player.hasSkill("xd_jiji")) break;
                    const name = get.name(basis, false);
                    if (!name) continue;
                    let normal = player.getCards("he").filter(card => skill.sameName(card, name, player));
                    let moved = u.getMovedOutCards(player).filter(card => skill.sameName(card, name, player));
                    if (!normal.length && !moved.length) continue;

                    const controls = [];
                    if (normal.length) controls.push("移出一张同名牌");
                    if (moved.length) controls.push("移去一张同名牌");
                    controls.push("cancel2");
                    const choice = await player.chooseControl(controls).set(
                      "prompt",
                      "【击楫】：" + get.translation(basis) + "进入弃牌堆，你可以移出或移去一张自己的同名牌"
                    ).set("ai", () => {
                      const controls = get.event().controls || [];
                      const index = controls.indexOf("移出一张同名牌");
                      return index >= 0 ? index : 0;
                    }).forResult();
                    if (!choice?.control || choice.control === "cancel2") continue;

                    if (choice.control === "移出一张同名牌") {
                      normal = player.getCards("he").filter(card => skill.sameName(card, name, player));
                      if (!normal.length) continue;
                      const result = await player.chooseCard({
                        position: "he",
                        selectCard: 1,
                        forced: true,
                        prompt: "【击楫】：选择一张自己的“" + get.translation(name) + "”移出",
                        filterCard(card, player) {
                          return get.name(card, player) === get.event().xd_jiji_name;
                        }
                      }).set("xd_jiji_name", name).set("ai", card => 7 - get.value(card, player)).forResult();
                      if (!result?.bool || !result.cards?.length) continue;
                      player.logSkill("xd_jiji");
                      skill.addLineCount(player, 0);
                      await u.moveOut(player, [result.cards[0]], {
                        group: "xd_jiji",
                        faceUp: true,
                        source: player,
                        animate: "gain2"
                      });
                      skill.sync(player);
                      continue;
                    }

                    moved = u.getMovedOutCards(player).filter(card => skill.sameName(card, name, player));
                    if (!moved.length) continue;
                    let card = moved[0];
                    if (moved.length > 1) {
                      const result = await player.chooseButton([
                        "###击楫###选择一张自己的“" + get.translation(name) + "”移去",
                        [moved, "card"]
                      ], true).set("ai", button => 7 - get.value(button.link, player)).forResult();
                      if (!result?.bool || !result.links?.length) continue;
                      card = result.links[0];
                    }
                    player.logSkill("xd_jiji");
                    skill.addLineCount(player, 0);
                    await u.removeMovedOut(player, [card]);
                    skill.sync(player);
                  }
                }
              },
              count: {
                trigger: {
                  player: "useCardAfter"
                },
                forced: true,
                popup: false,
                async content(event, trigger, player) {
                  const skill = lib.skill.xd_jiji, state = skill.getTurnState(player);
                  state.turnUses++;
                  const key = skill.getTurnKey();
                  const x = skill.getX(player);
                  skill.sync(player);
                  if (x <= 0 || state.turnUses !== x || state.drawTurn === key) return;

                  const result = await player.chooseBool(
                    "【击楫】：你本回合已使用" + x + "张牌，是否摸牌至" + x + "张？"
                  ).set("ai", () => {
                    const player = get.player();
                    const x = lib.skill.xd_jiji.getX(player);
                    if (player.countCards("h") < x) return 1;
                    const state = lib.skill.xd_jiji.getState(player);
                    return state.lines[2] > state.lines[1] ? 1 : 0;
                  }).forResult();
                  if (!result?.bool) return;

                  state.drawTurn = key;
                  player.logSkill("xd_jiji");
                  skill.addLineCount(player, 1);
                  await player.drawTo(x);
                  skill.sync(player);
                }
              },
              consume: {
                trigger: {
                  player: "useCardBegin"
                },
                forced: true,
                popup: false,
                filter(event) {
                  return lib.skill.xd_jiji.isJijiUse(event);
                },
                content(event, trigger, player) {
                  player.logSkill("xd_jiji");
                  lib.skill.xd_jiji.addLineCount(player, 2);
                }
              }
            },
            ai: {
              order: 8,
              result: {
                player: 1
              }
            }
          },
          // 温峤
          xd_xuebian: {
            enable: "chooseToUse",
            init(player) {
              lib.skill.xd_xuebian.getOrder(player);
              lib.skill.xd_xuebian.getStageState(player);
            },
            conditionClauses: [
              ["本阶段没有角色使用牌", "本阶段没有角色获得牌"],
              ["你的体力值等于上限", "你的手牌数等于上限"],
              ["场上没有武器牌", "场上没有与你势力不同的角色"]
            ],
            effects: [
              ["wuxie", "dongzhuxianji"],
              ["taoyuan", "chuqibuyi"],
              ["jiedao", "yuanjiao"]
            ],
            getOrder(player) {
              let order = player.storage.xd_xuebian_order;
              if (!Array.isArray(order) || order.length !== 3 || new Set(order).size !== 3 || order.some(i => ![0, 1, 2].includes(i))) {
                order = player.storage.xd_xuebian_order = [0, 1, 2];
              }
              return order;
            },
            getStageState(player) {
              let state = player.storage.xd_xuebian_stage;
              if (!state || typeof state !== "object") {
                state = player.storage.xd_xuebian_stage = {
                  name: null,
                  phase: null,
                  used: false,
                  gained: false
                };
              }
              return state;
            },
            sync(player) {
              if (typeof player.syncStorage === "function") {
                player.syncStorage("xd_xuebian_order");
                player.syncStorage("xd_xuebian_stage");
              }
            },
            getStageName(event) {
              const names = new Set(["phaseZhunbei", "phaseJudge", "phaseDraw", "phaseUse", "phaseDiscard", "phaseJieshu"]);
              let current = event || _status.event;
              let guard = 0;
              while (current && guard++ < 40) {
                if (names.has(current.name)) return current.name;
                current = current.getParent?.();
              }
              return null;
            },
            resetStage(player, triggername, phasePlayer) {
              const state = lib.skill.xd_xuebian.getStageState(player);
              state.name = String(triggername || "").replace(/Begin\d*$/, "");
              state.phase = phasePlayer?.playerid || _status.currentPhase?.playerid || null;
              state.used = false;
              state.gained = false;
              lib.skill.xd_xuebian.sync(player);
            },
            ensureStage(player, event) {
              const skill = lib.skill.xd_xuebian;
              const name = skill.getStageName(event);
              if (!name) return null;
              const state = skill.getStageState(player);
              const current = _status.currentPhase;
              const phase = current?.playerid || null;
              // 阶段开始触发仍负责正常重置；这里再做一次“按实际事件链校准”。
              // 某些 chooseToUse 路径进入新的阶段后，主动技过滤会早于/脱离我们保存的
              // phase*Begin 状态读取。若仍沿用上一阶段的 gained/used，就会把摸牌阶段的
              // “获得过牌”错误带进出牌阶段，导致灼然的【洞烛先机】分支被封死。
              if (state.name !== name || (state.phase && phase && state.phase !== phase)) {
                state.name = name;
                state.phase = phase;
                state.used = false;
                state.gained = false;
                skill.sync(player);
              }
              return state;
            },
            inTrackedStage(player, event) {
              return !!lib.skill.xd_xuebian.ensureStage(player, event);
            },
            hasGain(event) {
              if (!event) return false;
              if (event.name === "gain") return !Array.isArray(event.cards) || event.cards.length > 0;
              if (event.name === "loseAsync") {
                if (typeof event.getg !== "function") return true;
                return game.players.concat(game.dead || []).some(current => {
                  try {
                    return (event.getg(current) || []).length > 0;
                  } catch (e) {
                    return false;
                  }
                });
              }
              return true;
            },
            conditionPass(player, block, branch, event) {
              const skill = lib.skill.xd_xuebian;
              if (block === 0) {
                const state = skill.ensureStage(player, event);
                if (!state) return false;
                return branch === 0 ? !state.used : !state.gained;
              }
              if (block === 1) {
                if (branch === 0) return player.hp === player.maxHp;
                const limit = typeof player.getHandcardLimit === "function" ? player.getHandcardLimit() : player.maxHp;
                return player.countCards("h") === limit;
              }
              if (block === 2) {
                if (branch === 0) {
                  return !game.hasPlayer(current => current.getCards("e").some(card => get.subtype(card, current) === "equip1"));
                }
                return !game.hasPlayer(current => current !== player && current.group !== player.group);
              }
              return false;
            },
            materialAvailable(player, slot) {
              if (slot === 0) return player.countCards("ej") > 0;
              if (slot === 1) return player.countCards("h") > 0;
              return true;
            },
            getOption(name) {
              const skill = lib.skill.xd_xuebian;
              for (let slot = 0; slot < skill.effects.length; slot++) {
                const branch = skill.effects[slot].indexOf(name);
                if (branch !== -1) return { slot, branch, name };
              }
              return null;
            },
            getOptions(event, player) {
              const skill = lib.skill.xd_xuebian;
              if (!event || event.responded || typeof event.filterCard !== "function") return [];
              const order = skill.getOrder(player);
              const result = [];
              for (let slot = 0; slot < 3; slot++) {
                if (!skill.materialAvailable(player, slot)) continue;
                for (let branch = 0; branch < 2; branch++) {
                  const block = order[slot];
                  if (!skill.conditionPass(player, block, branch, event)) continue;
                  const name = skill.effects[slot][branch];
                  if (!lib.card[name]) continue;
                  const card = { name, isCard: true };
                  try {
                    if (!event.filterCard(card, player, event)) continue;
                  } catch (e) {
                    continue;
                  }
                  result.push({ slot, branch, block, name });
                }
              }
              return result;
            },
            getVCardList(event, player) {
              // 【穴变】写死的是六个具体牌名，不应要求这些牌当前真的被加入牌堆。
              // 直接生成本体 vcard 数据，避免【洞烛先机】等牌因当前模式 inpile 不含它而
              // 从选牌框里消失；按钮本身仍完全使用原生 vcard UI。
              const options = lib.skill.xd_xuebian.getOptions(event, player);
              const result = [];
              const seen = new Set();
              for (const item of options) {
                if (seen.has(item.name)) continue;
                seen.add(item.name);
                result.push(["锦囊", "", item.name]);
              }
              return result;
            },
            isXuebianUse(event) {
              const name = event?.skill;
              if (name === "xd_xuebian" || name === "xd_xuebian_backup") return true;
              if (!name) return false;
              try {
                return get.info(name)?.sourceSkill === "xd_xuebian";
              } catch (e) {
                return false;
              }
            },
            allClausesFalse(player, event) {
              const skill = lib.skill.xd_xuebian;
              for (let block = 0; block < 3; block++) {
                for (let branch = 0; branch < 2; branch++) {
                  if (skill.conditionPass(player, block, branch, event)) return false;
                }
              }
              return true;
            },
            orderLabel(order) {
              const short = ["使用/获得", "体力/手牌", "武器/势力"];
              return "灼然←" + short[order[0]] + "；谬敬←" + short[order[1]] + "；挽驾←" + short[order[2]];
            },
            filter(event, player) {
              return lib.skill.xd_xuebian.getOptions(event, player).length > 0;
            },
            chooseButton: {
              dialog(event, player) {
                const list = lib.skill.xd_xuebian.getVCardList(event, player);
                return ui.create.dialog("穴变：选择要转化使用的牌", [list, "vcard"]);
              },
              filter(button, player) {
                const event = _status.event.getParent();
                if (!event || !Array.isArray(button.link)) return false;
                const name = button.link[2];
                return lib.skill.xd_xuebian.getOptions(event, player).some(item => item.name === name);
              },
              check(button) {
                const player = get.player();
                const option = lib.skill.xd_xuebian.getOption(button.link?.[2]);
                if (!option) return 0;
                const card = { name: option.name, isCard: true };
                let value = player.getUseValue(card);
                if (option.slot === 0) value -= 1.5;
                if (option.slot === 1) value -= Math.max(1, Math.ceil(player.countCards("h") / 2));
                return value;
              },
              backup(links) {
                const player = get.player();
                const name = links[0]?.[2];
                const option = lib.skill.xd_xuebian.getOption(name);
                const base = {
                  popname: true,
                  log: false,
                  sourceSkill: "xd_xuebian",
                  viewAs: { name, isCard: true }
                };
                if (!option) return { ...base, filterCard: () => false, selectCard: -1 };
                if (option.slot === 0) {
                  return {
                    ...base,
                    position: "ej",
                    selectCard: 1,
                    filterCard: () => true,
                    check(card) {
                      return 7 - get.value(card, player);
                    }
                  };
                }
                if (option.slot === 1) {
                  const min = Math.max(1, Math.ceil(player.countCards("h") / 2));
                  return {
                    ...base,
                    position: "h",
                    selectCard: [min, Infinity],
                    complexCard: true,
                    filterCard: () => true,
                    check(card) {
                      if (ui.selected.cards.length >= min) return 0;
                      return 7 - get.value(card, player);
                    }
                  };
                }
                return {
                  ...base,
                  filterCard: () => false,
                  selectCard: -1
                };
              },
              prompt(links) {
                const player = get.player();
                const name = links[0]?.[2];
                const option = lib.skill.xd_xuebian.getOption(name);
                if (!option) return "发动【穴变】";
                const order = lib.skill.xd_xuebian.getOrder(player);
                const clause = lib.skill.xd_xuebian.conditionClauses[order[option.slot]][option.branch];
                if (option.slot === 0) return "【穴变】" + clause + "：选择你场上一张牌，当" + get.translation({ name, isCard: true }) + "使用";
                if (option.slot === 1) return "【穴变】" + clause + "：选择至少半数手牌，当" + get.translation({ name, isCard: true }) + "使用";
                return "【穴变】" + clause + "：视为使用" + get.translation({ name, isCard: true });
              }
            },
            hiddenCard(player, name) {
              const event = _status.event;
              if (!event || event.name !== "chooseToUse") return false;
              return lib.skill.xd_xuebian.getOptions(event, player).some(item => item.name === name);
            },
            group: ["xd_xuebian_stage", "xd_xuebian_track", "xd_xuebian_log", "xd_xuebian_after"],
            subSkill: {
              backup: {},
              stage: {
                charlotte: true,
                forced: true,
                silent: true,
                popup: false,
                firstDo: true,
                trigger: {
                  global: ["phaseZhunbeiBegin", "phaseJudgeBegin", "phaseDrawBegin", "phaseUseBegin", "phaseDiscardBegin", "phaseJieshuBegin"]
                },
                content(event, trigger, player) {
                  lib.skill.xd_xuebian.resetStage(player, event.triggername, trigger.player);
                }
              },
              track: {
                charlotte: true,
                forced: true,
                silent: true,
                popup: false,
                trigger: {
                  global: ["useCard", "gainAfter", "loseAsyncAfter"]
                },
                filter(event, player) {
                  const skill = lib.skill.xd_xuebian;
                  if (!skill.inTrackedStage(player, event)) return false;
                  if (event.name === "loseAsync" && !skill.hasGain(event)) return false;
                  return true;
                },
                content(event, trigger, player) {
                  const state = lib.skill.xd_xuebian.getStageState(player);
                  if (event.triggername === "useCard") state.used = true;
                  else state.gained = true;
                  lib.skill.xd_xuebian.sync(player);
                }
              },
              log: {
                charlotte: true,
                forced: true,
                popup: false,
                trigger: { player: "useCardBegin" },
                filter(event) {
                  return lib.skill.xd_xuebian.isXuebianUse(event);
                },
                content(event, trigger, player) {
                  player.logSkill("xd_xuebian");
                }
              },
              after: {
                charlotte: true,
                direct: true,
                trigger: { player: "useCardAfter" },
                filter(event, player) {
                  return lib.skill.xd_xuebian.isXuebianUse(event) && lib.skill.xd_xuebian.allClausesFalse(player, event);
                },
                async content(event, trigger, player) {
                  const skill = lib.skill.xd_xuebian;
                  const current = skill.getOrder(player).slice();
                  const plans = [
                    [current[1], current[2], current[0]],
                    [current[2], current[0], current[1]]
                  ];
                  const controls = plans.map(plan => skill.orderLabel(plan));
                  const result = await player.chooseControl(controls)
                    .set("prompt", "【穴变】：所有前半句均不满足，交换三个前半句")
                    .set("ai", () => 0)
                    .forResult();
                  let index = controls.indexOf(result.control);
                  if (index < 0) index = 0;
                  player.storage.xd_xuebian_order = plans[index];
                  skill.sync(player);
                  player.logSkill("xd_xuebian");
                  game.log(player, "交换了【穴变】的三个前半句：", "#g" + skill.orderLabel(plans[index]));
                }
              }
            },
            ai: {
              order: 8,
              result: { player: 1 }
            }
          },
          // 卓文君
          xd_xiangfu: {
            enable: "chooseToUse",
            mark: true,
            marktext: "赴",
            init(player) {
              lib.skill.xd_xiangfu.getState(player);
              lib.skill.xd_xiangfu.sync(player);
            },
            onremove(player) {
              delete player.storage.xd_xiangfu_state;
              player.removeTip?.("xd_xiangfu");
            },
            relations: {
              sha: { key: "xiangsi", label: "相思", text: "正负性不变" },
              jiu: { key: "xiangfeng", label: "相逢", text: "变为0" },
              shan: { key: "xiangshi", label: "相失", text: "变为相反数" },
              tao: { key: "xiangshou", label: "相守", text: "未变化" }
            },
            getState(player) {
              const round = Math.max(0, Math.floor(Number(game.roundNumber) || 0));
              let state = player.storage.xd_xiangfu_state;
              if (!state || typeof state !== "object") {
                state = player.storage.xd_xiangfu_state = { round, used: [] };
              }
              if (state.round !== round) {
                state.round = round;
                state.used = [];
              }
              if (!Array.isArray(state.used)) state.used = [];
              state.used = state.used.filter(name => ["sha", "jiu", "shan", "tao"].includes(name)).toUniqued();
              return state;
            },
            sync(player) {
              const skill = lib.skill.xd_xiangfu;
              const state = skill.getState(player);
              if (typeof player.syncStorage === "function") player.syncStorage("xd_xiangfu_state");
              player.markSkill("xd_xiangfu");
              const unused = ["sha", "jiu", "shan", "tao"].filter(name => !state.used.includes(name));
              const short = { sha: "思", jiu: "逢", shan: "失", tao: "守" };
              lib.xd_utils.updateTip?.(
                player,
                "xd_xiangfu",
                unused.length ? "相赴｜本轮尚可 " + unused.map(name => short[name]).join("·") : "相赴｜本轮四项均已使用"
              );
            },
            intro: {
              markcount(storage, player) {
                return Math.max(0, 4 - lib.skill.xd_xiangfu.getState(player).used.length);
              },
              content(storage, player) {
                const skill = lib.skill.xd_xiangfu;
                const state = skill.getState(player);
                const names = ["sha", "jiu", "shan", "tao"];
                return names.map(name => {
                  const relation = skill.relations[name];
                  return (state.used.includes(name) ? "已用" : "可用") + "：" + relation.label + "·" + relation.text + " → 【" + get.translation(name) + "】";
                }).join("<br>");
              }
            },
            getRelation(player, target) {
              if (!player || !target || player === target) return null;
              const before = player.countCards("h") - target.countCards("h");
              const after = before === 0 ? 0 : before - 2 * Math.sign(before);
              let name;
              if (after === before) name = "tao";
              else if (after === 0) name = "jiu";
              else if (Math.sign(after) === -Math.sign(before)) name = "shan";
              else name = "sha";
              return {
                before,
                after,
                name,
                ...lib.skill.xd_xiangfu.relations[name]
              };
            },
            canDiscardHand(player) {
              return !!player?.getCards("h").some(card => {
                try {
                  return lib.filter.cardDiscardable(card, player);
                } catch (e) {
                  return true;
                }
              });
            },
            canAdjust(player, target, relation) {
              if (!relation) return false;
              if (relation.before > 0) return lib.skill.xd_xiangfu.canDiscardHand(player);
              if (relation.before < 0) return lib.skill.xd_xiangfu.canDiscardHand(target);
              return true;
            },
            cardPasses(event, player, name) {
              if (!event || event.responded || typeof event.filterCard !== "function") return false;
              const card = get.autoViewAs({ name, isCard: true }, "unsure");
              try {
                return !!event.filterCard(card, player, event);
              } catch (e) {
                return false;
              }
            },
            getCandidateInfo(event, player, target) {
              const skill = lib.skill.xd_xiangfu;
              if (!target || target === player || !target.isIn?.()) return null;
              const relation = skill.getRelation(player, target);
              if (!relation) return null;
              const state = skill.getState(player);
              // “每轮各限一次”限制的是四种结果，而不是总发动次数或某个目标。
              if (state.used.includes(relation.name)) return null;
              if (!skill.canAdjust(player, target, relation)) return null;
              if (!skill.cardPasses(event, player, relation.name)) return null;
              return { target, relation };
            },
            getCandidates(event, player) {
              return game.players
                .filter(target => target !== player && target.isIn())
                .map(target => lib.skill.xd_xiangfu.getCandidateInfo(event, player, target))
                .filter(Boolean);
            },
            getPlayerById(id) {
              return game.players.concat(game.dead || []).find(current => current.playerid === id) || null;
            },
            useRelation(player, relation) {
              const state = lib.skill.xd_xiangfu.getState(player);
              if (!state.used.includes(relation.name)) state.used.push(relation.name);
              lib.skill.xd_xiangfu.sync(player);
            },
            async adjust(player, target, relation) {
              if (relation.before > 0) {
                const discarded = await player.chooseToDiscard(
                  "h",
                  1,
                  true,
                  card => lib.filter.cardDiscardable(card, player),
                  "【相赴】：你的手牌数较多，弃置一张手牌"
                ).forResult();
                if (!discarded?.bool) return false;
                if (target.isIn()) await target.draw(1);
              } else if (relation.before < 0) {
                const discarded = await target.chooseToDiscard(
                  "h",
                  1,
                  true,
                  card => lib.filter.cardDiscardable(card, target),
                  "【相赴】：你的手牌数较多，弃置一张手牌"
                ).forResult();
                if (!discarded?.bool) return false;
                if (player.isIn()) await player.draw(1);
              }
              return true;
            },
            async resolve(player, target, expectedName) {
              const skill = lib.skill.xd_xiangfu;
              if (!player?.isIn?.() || !target?.isIn?.() || player === target) return false;
              const relation = skill.getRelation(player, target);
              const state = skill.getState(player);
              // 从选择参与者到正式确认之间通常不会插入其他事件；这里仍做一次兜底复核，
              // 防止联机/其他扩展改写状态后把错误的关系当成合法结果结算。
              if (!relation || relation.name !== expectedName || state.used.includes(relation.name) || !skill.canAdjust(player, target, relation)) return false;

              skill.useRelation(player, relation);
              player.logSkill("xd_xiangfu", target);
              lib.skill.xd_yixin?.recordXiangfu?.(player, target);

              game.log(
                player,
                "与",
                target,
                "发动【相赴】，手牌差值",
                "#y" + relation.before,
                "→",
                "#y" + relation.after,
                "（" + relation.label + "）"
              );
              return await skill.adjust(player, target, relation);
            },
            filter(event, player) {
              return lib.skill.xd_xiangfu.getCandidates(event, player).length > 0;
            },
            chooseButton: {
              dialog(event, player) {
                const skill = lib.skill.xd_xiangfu;
                const list = skill.getCandidates(event, player);
                const dialog = ui.create.dialog("相赴：选择一名角色与其调整手牌", [list.map(item => item.target), "player"]);
                if (list.length) {
                  const line = list.map(item => {
                    const r = item.relation;
                    return get.translation(item.target) + "：" + r.before + "→" + r.after + "，" + r.label + "【" + get.translation(r.name) + "】";
                  }).join("；");
                  dialog.addText(line, true);
                }
                return dialog;
              },
              filter(button, player) {
                const event = _status.event.getParent();
                return !!lib.skill.xd_xiangfu.getCandidateInfo(event, player, button.link);
              },
              check(button) {
                const player = get.player();
                const event = _status.event.getParent();
                const info = lib.skill.xd_xiangfu.getCandidateInfo(event, player, button.link);
                if (!info) return 0;
                const card = { name: info.relation.name, isCard: true };
                let value = player.getUseValue(card);
                // 调整本身也计入一点简单的手牌收益，避免AI只看视为使用的基本牌。
                if (info.relation.before < 0) value += 1.5;
                else if (info.relation.before > 0) value -= 1;
                const att = get.attitude(player, button.link);
                if (info.relation.before > 0) value += att > 0 ? 0.8 : -0.5;
                else if (info.relation.before < 0) value += att > 0 ? -0.6 : 0.8;
                return value;
              },
              backup(links, player) {
                const target = links[0];
                const owner = player || get.player();
                const relation = lib.skill.xd_xiangfu.getRelation(owner, target);
                const targetId = target?.playerid;
                const expectedName = relation?.name || "sha";
                return {
                  filterCard: () => false,
                  selectCard: -1,
                  popname: true,
                  log: false,
                  sourceSkill: "xd_xiangfu",
                  viewAs: { name: expectedName, isCard: true },
                  async precontent(event, trigger, player) {
                    const current = player || event.player;
                    const partner = lib.skill.xd_xiangfu.getPlayerById(targetId);
                    if (!current || !partner) return;
                    const ok = await lib.skill.xd_xiangfu.resolve(current, partner, expectedName);
                    if (!ok) {
                      // 极端情况下状态在确认前被外部代码改变：不伪造一次错误的【相赴】用牌。
                      event.result = { bool: false };
                    }
                  }
                };
              },
              prompt(links, player) {
                const target = links[0];
                const current = player || get.player();
                const relation = lib.skill.xd_xiangfu.getRelation(current, target);
                if (!relation) return "发动【相赴】";
                return "与" + get.translation(target) + "相赴：手牌差值将由" + relation.before + "变为" + relation.after + "，视为使用【" + get.translation(relation.name) + "】";
              }
            },
            hiddenCard(player, name) {
              if (!["sha", "jiu", "shan", "tao"].includes(name)) return false;
              const event = _status.event;
              if (!event || event.name !== "chooseToUse") return false;
              return lib.skill.xd_xiangfu.getCandidates(event, player).some(item => item.relation.name === name);
            },
            ai: {
              order(item, player) {
                const event = _status.event;
                const list = lib.skill.xd_xiangfu.getCandidates(event, player);
                if (!list.length) return 1;
                return Math.max(...list.map(item => get.order({ name: item.relation.name, isCard: true }) || 1)) + 0.05;
              },
              respondSha: true,
              respondShan: true,
              save: true,
              skillTagFilter(player, tag) {
                const event = _status.event;
                if (!event || event.name !== "chooseToUse") return false;
                const need = tag === "respondSha" ? "sha" : tag === "respondShan" ? "shan" : null;
                const list = lib.skill.xd_xiangfu.getCandidates(event, player);
                if (need) return list.some(item => item.relation.name === need);
                if (tag === "save") return list.some(item => ["tao", "jiu"].includes(item.relation.name));
                return list.length > 0;
              },
              result: { player: 1 }
            },
            subSkill: {
              backup: {}
            }
          },
          xd_yixin: {
            locked: true,
            forced: true,
            mark: true,
            marktext: "心",
            init(player) {
              lib.skill.xd_yixin.getState(player);
              lib.skill.xd_yixin.syncGrant(player);
            },
            onremove(player) {
              // 历史参与者不清空：若【一心】日后重新获得，“唯一”仍按此前真实参与史判断。
              lib.skill.xd_yixin.clearGrant(player);
            },
            getState(player) {
              let state = player.storage.xd_yixin_state;
              if (!state || typeof state !== "object") {
                state = player.storage.xd_yixin_state = { participants: [], grantee: null };
              }
              if (!Array.isArray(state.participants)) state.participants = [];
              state.participants = state.participants.filter(Boolean).toUniqued();
              if (typeof state.grantee !== "string") state.grantee = null;
              return state;
            },
            grantKey(player) {
              return "xd_yixin_" + player.playerid;
            },
            findPlayer(id) {
              return game.players.concat(game.dead || []).find(current => current.playerid === id) || null;
            },
            syncStorage(player) {
              if (typeof player.syncStorage === "function") player.syncStorage("xd_yixin_state");
              player.markSkill("xd_yixin");
            },
            addGrant(target, key) {
              if (!target) return;
              if (typeof target.addAdditionalSkill === "function") {
                target.addAdditionalSkill(key, "xd_xiangfu");
                return;
              }
              // 仅作旧环境兜底；目标本来就有【相赴】时绝不重复操作。
              target.storage.xd_yixin_fallback_sources ??= [];
              if (!target.storage.xd_yixin_fallback_sources.includes(key)) target.storage.xd_yixin_fallback_sources.push(key);
              if (!target.hasSkill("xd_xiangfu")) {
                target.storage.xd_yixin_fallback_added = true;
                target.addSkill("xd_xiangfu");
              }
            },
            removeGrant(target, key) {
              if (!target) return;
              if (typeof target.removeAdditionalSkill === "function") {
                target.removeAdditionalSkill(key);
                return;
              }
              const list = target.storage.xd_yixin_fallback_sources;
              if (Array.isArray(list)) {
                target.storage.xd_yixin_fallback_sources = list.filter(item => item !== key);
                if (!target.storage.xd_yixin_fallback_sources.length && target.storage.xd_yixin_fallback_added) {
                  delete target.storage.xd_yixin_fallback_added;
                  target.removeSkill("xd_xiangfu");
                }
              }
            },
            clearGrant(player) {
              const skill = lib.skill.xd_yixin;
              const state = skill.getState(player);
              const key = skill.grantKey(player);
              const target = skill.findPlayer(state.grantee);
              if (target) skill.removeGrant(target, key);
              state.grantee = null;
              skill.syncStorage(player);
            },
            syncGrant(player) {
              const skill = lib.skill.xd_yixin;
              const state = skill.getState(player);
              const desired = state.participants.length === 1 ? state.participants[0] : null;
              const key = skill.grantKey(player);

              if (state.grantee && state.grantee !== desired) {
                const old = skill.findPlayer(state.grantee);
                if (old) skill.removeGrant(old, key);
              }
              state.grantee = desired;
              if (desired) {
                const target = skill.findPlayer(desired);
                if (target) skill.addGrant(target, key);
              }
              skill.syncStorage(player);
            },
            addParticipant(player, target) {
              if (!player || !target || player === target) return false;
              const state = lib.skill.xd_yixin.getState(player);
              if (state.participants.includes(target.playerid)) return false;
              state.participants.push(target.playerid);
              lib.skill.xd_yixin.syncGrant(player);
              return true;
            },
            recordXiangfu(user, partner) {
              const skill = lib.skill.xd_yixin;
              // 每名卓文君维护自己的“一心”参与史。
              // 1. 卓文君亲自发动【相赴】：她选择的对象加入历史；
              // 2. 当前唯一参与者借【一心】拥有【相赴】后发动：若选择的不是该卓文君，
              //    新对象也加入历史，于是“唯一”永久被打破。
              for (const owner of game.players.concat(game.dead || [])) {
                if (!owner || !owner.hasSkill?.("xd_yixin")) continue;
                const state = skill.getState(owner);
                if (owner === user) {
                  if (partner !== owner) skill.addParticipant(owner, partner);
                  continue;
                }
                if (state.participants.length === 1 && state.participants[0] === user.playerid) {
                  if (partner !== owner) skill.addParticipant(owner, partner);
                }
              }
            },
            intro: {
              content(storage, player) {
                const state = lib.skill.xd_yixin.getState(player);
                if (!state.participants.length) return "尚无其他角色参与过你的【相赴】。";
                const names = state.participants.map(id => {
                  const target = lib.skill.xd_yixin.findPlayer(id);
                  return target ? get.translation(target) : "一名角色";
                });
                if (state.participants.length === 1) return names[0] + "是唯一参与过你【相赴】的其他角色，视为拥有【相赴】。";
                return "已有多名其他角色参与过你的【相赴】：" + names.join("、") + "；不再有角色因【一心】视为拥有【相赴】。";
              }
            }
          },
          // 虞姬
          // 【曲兴】的“直到”是独立持续状态：虞姬死亡、失去技能，甚至曲兴实体牌被【舞阑】用掉，
          // 都不会自行结束。只有该次【曲兴】的虞姬或承受者下一次“主动发动技能”时才结束。
          xd_quxing: {
            enable: "phaseUse",
            position: "h",
            selectCard: [2, Infinity],
            selectTarget: 1,
            discard: false,
            lose: false,
            delay: false,
            complexCard: true,
            filter(event, player) {
              const cards = player.getCards("h");
              const count = new Map();
              for (const card of cards) {
                const name = get.name(card, player);
                count.set(name, (count.get(name) || 0) + 1);
              }
              return [...count.values()].some(num => num >= 2) && game.hasPlayer(target => target !== player);
            },
            filterCard(card, player) {
              const name = get.name(card, player);
              if (ui.selected.cards.length && get.name(ui.selected.cards[0], player) !== name) return false;
              return player.countCards("h", current => get.name(current, player) === name) >= 2;
            },
            filterTarget(card, player, target) {
              return target !== player;
            },
            check(card) {
              // 同名牌至少两张即可成立；AI通常优先交低价值牌，不主动多交。
              if (ui.selected.cards.length >= 2) return 0;
              return 7 - get.value(card);
            },
            async content(event, trigger, player) {
              const target = event.target;
              const engine = lib.skill.xd_quxing_engine;
              game.addGlobalSkill("xd_quxing_engine");

              // 自己再次发动【曲兴】本身就是“下次发动技能”：旧【曲兴】先结束，再建立新的。
              await engine.expireFor(player);

              const cards = (event.cards || []).filter(card => player.getCards("h").includes(card));
              if (cards.length < 2 || !target) return;
              const name = get.name(cards[0], player);
              const next = target.addToExpansion({ cards, source: player, animate: "give" });
              if (!next.gaintag.includes("xd_quxing")) next.gaintag.push("xd_quxing");
              await next;

              const expansion = new Set(target.getExpansions("xd_quxing"));
              const actual = cards.filter(card => expansion.has(card));
              if (!actual.length) return;

              const states = engine.ensureStates(target);
              states.push({
                id: engine.nextId(),
                owner: player.playerid,
                target: target.playerid,
                name,
                cardids: actual.map(card => card.cardid).filter(Boolean)
              });
              if (!target.hasSkill("xd_quxing_holder")) target.addSkill("xd_quxing_holder");
              engine.sync(target);

              await player.draw(actual.length);
              await target.draw(actual.length);
            },
            ai: {
              order: 7.5,
              result: {
                player: 1,
                target(player, target) {
                  return get.attitude(player, target) > 0 ? 1 : 0;
                }
              }
            }
          },
          xd_quxing_holder: {
            charlotte: true,
            mark: true,
            marktext: "曲",
            intro: {
              mark(dialog, content, player) {
                const cards = player.getExpansions("xd_quxing");
                if (cards.length) dialog.addAuto(cards);
                const states = lib.skill.xd_quxing_engine.ensureStates(player);
                if (states.length) {
                  const names = states.map(state => get.translation(state.name)).toUniqued();
                  dialog.addText("持续中的【曲兴】同名牌：" + names.join("、"));
                }
              },
              markcount(storage, player) {
                return player.getExpansions("xd_quxing").length;
              }
            }
          },
          xd_quxing_engine: {
            charlotte: true,
            forced: true,
            popup: false,
            forceDie: true,
            firstDo: true,
            priority: 100000,
            trigger: {
              global: ["logSkillBegin", "gainAfter", "loseAfter", "loseAsyncAfter", "cardsDiscardAfter", "useCard1", "useCardAfter"]
            },
            nextId() {
              game.xd_quxing_serial = (Number(game.xd_quxing_serial) || 0) + 1;
              return "xd_quxing_" + game.xd_quxing_serial;
            },
            allPlayers() {
              return game.players.concat(game.dead || []);
            },
            findPlayer(id) {
              return lib.skill.xd_quxing_engine.allPlayers().find(player => player.playerid === id) || null;
            },
            ensureStates(target) {
              if (!target) return [];
              if (!Array.isArray(target.storage.xd_quxing_states)) target.storage.xd_quxing_states = [];
              return target.storage.xd_quxing_states;
            },
            sync(target) {
              if (!target) return;
              if (typeof target.syncStorage === "function") target.syncStorage("xd_quxing_states");
              const states = lib.skill.xd_quxing_engine.ensureStates(target);
              if (states.length) {
                if (!target.hasSkill("xd_quxing_holder")) target.addSkill("xd_quxing_holder");
                target.markSkill("xd_quxing_holder");
              } else if (target.hasSkill("xd_quxing_holder")) {
                target.removeSkill("xd_quxing_holder");
              }
            },
            // 实体曲兴牌一旦离开 expansion，就不再属于原来那批曲兴牌；
            // buff 本身仍按“直到发动技能”继续存在，因此只删 cardid，不删 state。
            pruneCardIds() {
              const engine = lib.skill.xd_quxing_engine;
              for (const holder of engine.allPlayers()) {
                const ids = new Set(holder.getExpansions("xd_quxing").map(card => card.cardid).filter(Boolean));
                let changed = false;
                for (const state of engine.ensureStates(holder)) {
                  const old = Array.isArray(state.cardids) ? state.cardids : [];
                  const next = old.filter(id => ids.has(id));
                  if (next.length !== old.length) {
                    state.cardids = next;
                    changed = true;
                  }
                }
                if (changed) engine.sync(holder);
              }
            },
            // “发动”只认玩家主动选择发动的技能：主动技、非锁定/非强制的触发技。
            // 锁定技、强制技、静默/状态 helper，以及【曲兴】【舞阑】的延迟结算均不算。
            isActiveSkill(name) {
              if (!name) return false;
              const info = get.info(name);
              if (!info) return true;
              if (info.enable) return true;
              if (info.forced || info.locked || info.silent || info.charlotte) return false;
              return true;
            },
            getRelatedStates(actor, role) {
              if (!actor) return [];
              const result = [];
              for (const holder of lib.skill.xd_quxing_engine.allPlayers()) {
                for (const state of lib.skill.xd_quxing_engine.ensureStates(holder)) {
                  if (role === "owner" && state.owner === actor.playerid) result.push([holder, state]);
                  if (role === "target" && state.target === actor.playerid) result.push([holder, state]);
                }
              }
              return result;
            },
            async expireFor(actor) {
              if (!actor) return;
              const engine = lib.skill.xd_quxing_engine;
              const grouped = new Map();
              for (const holder of engine.allPlayers()) {
                const states = engine.ensureStates(holder);
                const expiring = states.filter(state => state.owner === actor.playerid || state.target === actor.playerid);
                if (!expiring.length) continue;
                const ids = new Set(expiring.flatMap(state => state.cardids || []));
                const cards = holder.getExpansions("xd_quxing").filter(card => ids.has(card.cardid));
                holder.storage.xd_quxing_states = states.filter(state => !expiring.includes(state));
                engine.sync(holder);
                if (cards.length) grouped.set(holder, cards);
              }
              // 状态先结束，再让尚留在武将牌上的对应【曲兴】牌进入弃牌堆；
              // 这样弃置本身不会被误判为仍处于该 buff 中。
              for (const [holder, cards] of grouped) {
                await holder.loseToDiscardpile(cards);
              }
            },
            matchingNamesForOwner(owner) {
              return lib.skill.xd_quxing_engine.getRelatedStates(owner, "owner").map(([, state]) => state.name).toUniqued();
            },
            matchingNamesForTarget(target) {
              return lib.skill.xd_quxing_engine.getRelatedStates(target, "target").map(([, state]) => state.name).toUniqued();
            },
            gainedCards(trigger, owner) {
              if (!owner) return [];
              if (typeof trigger.getg === "function") {
                try {
                  const cards = trigger.getg(owner);
                  if (Array.isArray(cards)) return cards.slice();
                } catch (e) {}
              }
              return trigger.player === owner && Array.isArray(trigger.cards) ? trigger.cards.slice() : [];
            },
            async recastUsed(player, cards) {
              const list = [...new Set((cards || []).filter(card => get.itemtype(card) === "card"))];
              if (!player || !list.length) return;
              await player.recast(list, (current, recasting) => {
                const moving = recasting.filter(card => get.position(card, true) !== "d");
                if (moving.length) return game.cardsDiscard(moving);
              });
            },
            async content(event, trigger) {
              const engine = lib.skill.xd_quxing_engine;
              const name = event.triggername;

              if (name === "logSkillBegin") {
                const skill = trigger.skill || trigger.sourceSkill;
                if (engine.isActiveSkill(skill)) await engine.expireFor(trigger.player);
                return;
              }

              if (name === "gainAfter" || name === "loseAsyncAfter") {
                for (const owner of engine.allPlayers()) {
                  const names = engine.matchingNamesForOwner(owner);
                  if (!names.length) continue;
                  const cards = engine.gainedCards(trigger, owner).filter(card => {
                    return owner.getCards("he").includes(card) && names.includes(get.name(card, owner));
                  });
                  if (cards.length) await owner.recast([...new Set(cards)]);
                }
                engine.pruneCardIds();
                return;
              }

              if (name === "loseAfter" || name === "cardsDiscardAfter") {
                engine.pruneCardIds();
                return;
              }

              if (name === "useCard1") {
                const user = trigger.player;
                if (!user) return;
                // 由主动技能产生的用牌，先视为已经发动该技能，旧【曲兴】立即失效。
                if (trigger.skill && engine.isActiveSkill(trigger.skill)) await engine.expireFor(user);
                const names = engine.matchingNamesForTarget(user);
                if (!names.includes(get.name(trigger.card, user))) return;
                const cards = [...new Set((trigger.cards || []).filter(card => get.itemtype(card) === "card"))];
                if (cards.length) trigger._xd_quxing_recast_cards = cards;
                return;
              }

              if (name === "useCardAfter") {
                const cards = trigger._xd_quxing_recast_cards;
                if (cards?.length) await engine.recastUsed(trigger.player, cards);
                engine.pruneCardIds();
              }
            }
          },

          xd_wulan: {
            direct: true,
            trigger: {
              player: ["phaseZhunbeiEnd", "phaseJudgeEnd", "phaseDrawEnd", "phaseUseEnd", "phaseDiscardEnd", "phaseJieshuEnd"]
            },
            filter(event, player) {
              // 【舞阑】预先执行出来的阶段不能再次借未来，避免递归借阶段。
              return !event._xd_wulan_advanced;
            },
            phaseName(event, trigger) {
              const fromTrigger = String(trigger?.name || "");
              if (["phaseZhunbei", "phaseJudge", "phaseDraw", "phaseUse", "phaseDiscard", "phaseJieshu"].includes(fromTrigger)) return fromTrigger;
              return String(event.triggername || "").replace(/End$/, "");
            },
            phaseLabel(name) {
              return {
                phaseZhunbei: "准备阶段",
                phaseJudge: "判定阶段",
                phaseDraw: "摸牌阶段",
                phaseUse: "出牌阶段",
                phaseDiscard: "弃牌阶段",
                phaseJieshu: "结束阶段"
              }[name] || "该阶段";
            },
            ensureDebts(player) {
              if (!Array.isArray(player.storage.xd_wulan_debts)) player.storage.xd_wulan_debts = [];
              return player.storage.xd_wulan_debts;
            },
            ensurePending(player) {
              if (!Array.isArray(player.storage.xd_wulan_pending)) player.storage.xd_wulan_pending = [];
              return player.storage.xd_wulan_pending;
            },
            sync(player) {
              if (typeof player.syncStorage === "function") {
                player.syncStorage("xd_wulan_debts");
                player.syncStorage("xd_wulan_pending");
              }
            },
            async content(event, trigger, player) {
              const phase = lib.skill.xd_wulan.phaseName(event, trigger);
              if (!phase || typeof player[phase] !== "function") return;
              const ask = await player.chooseBool("是否发动【舞阑】，预先执行三轮后的" + lib.skill.xd_wulan.phaseLabel(phase) + "？")
                .set("ai", () => phase === "phaseUse" || phase === "phaseDraw")
                .forResult();
              if (!ask.bool) return;

              player.logSkill("xd_wulan");
              game.addGlobalSkill("xd_wulan_engine");
              game.addGlobalSkill("xd_quxing_engine");
              // 【舞阑】本身是主动发动：现有【曲兴】必须先在这一刻结束，
              // 之后预执行的阶段中才可能形成“舞阑→曲兴”的新顺序。
              await lib.skill.xd_quxing_engine.expireFor(player);

              const dueRound = (Number(game.roundNumber) || 0) + 3;
              const debts = lib.skill.xd_wulan.ensureDebts(player);
              debts.push({ phase, dueRound });

              const currentTurn = _status.currentPhase;
              const pending = lib.skill.xd_wulan.ensurePending(player);
              pending.push({
                phaseNumber: Number(game.phaseNumber) || 0,
                turnPlayer: currentTurn?.playerid || null
              });
              lib.skill.xd_wulan.sync(player);

              const next = player[phase]();
              next._xd_wulan_advanced = true;
              next._xd_wulan_source = player.playerid;
              await next;
            },
            ai: { expose: 0.1 }
          },
          xd_wulan_engine: {
            charlotte: true,
            forced: true,
            popup: false,
            forceDie: true,
            firstDo: true,
            priority: 100000,
            trigger: {
              global: [
                "phaseZhunbeiBefore", "phaseJudgeBefore", "phaseDrawBefore", "phaseUseBefore", "phaseDiscardBefore", "phaseJieshuBefore",
                "phaseAfter"
              ]
            },
            allPlayers() {
              return game.players.concat(game.dead || []);
            },
            purgeOldDebts(owner) {
              const list = lib.skill.xd_wulan.ensureDebts(owner);
              const round = Number(game.roundNumber) || 0;
              const next = list.filter(item => Number(item.dueRound) >= round);
              if (next.length !== list.length) {
                owner.storage.xd_wulan_debts = next;
                lib.skill.xd_wulan.sync(owner);
              }
            },
            async resolveTurnEnd(owner) {
              // “唯一有【曲兴】牌”只看此刻仍实际置于武将牌上的曲兴牌；
              // 【曲兴】的 buff 状态本身即使牌已被用掉，也仍可继续存在至技能发动。
              const holders = game.players.filter(target => target.getExpansions("xd_quxing").length > 0);
              if (holders.length !== 1) return;
              const holder = holders[0];
              const cards = holder.getExpansions("xd_quxing").filter(card => {
                const type = get.type(card, null, false);
                return type === "basic" || type === "trick";
              }).slice();
              if (!cards.length) return;

              for (const card of cards) {
                // 前一张牌结算过程中可能已令后续曲兴牌离开武将牌。
                if (!holder.getExpansions("xd_quxing").includes(card)) continue;
                if (owner?.isIn?.()) {
                  // 目标“转移至虞姬”发生在牌已经被使用之后，因此不重新检查虞姬是否为该牌合法目标。
                  // 直接创建真实 useCard 事件，实体【曲兴】牌作为材料离开 expansion。
                  await holder.useCard({
                    card,
                    cards: [card],
                    targets: [owner],
                    addCount: false,
                    skill: "xd_wulan_effect"
                  });
                } else {
                  // 虞姬已死亡：延迟的“令其使用”仍继续，但已经没有“你”可供转移目标。
                  // 让持牌者按此牌原本规则选择目标；若本来没有合法使用方式，再以无目标方式视为使用，确保“所有”都会被处理。
                  const result = await holder.chooseUseTarget({
                    card,
                    cards: [card],
                    forced: true,
                    addCount: false,
                    prompt: "【舞阑】：使用" + get.translation(card)
                  }).forResult();
                  if (!result?.bool && holder.getExpansions("xd_quxing").includes(card)) {
                    await holder.useCard({
                      card,
                      cards: [card],
                      targets: [],
                      addCount: false,
                      skill: "xd_wulan_effect"
                    });
                  }
                }
              }
            },
            async content(event, trigger) {
              const name = event.triggername;
              const engine = lib.skill.xd_wulan_engine;

              if (name !== "phaseAfter") {
                if (trigger._xd_wulan_advanced) return;
                const phase = String(name).replace(/Before$/, "");
                const owner = trigger.player;
                if (!owner) return;
                engine.purgeOldDebts(owner);
                const debts = lib.skill.xd_wulan.ensureDebts(owner);
                const round = Number(game.roundNumber) || 0;
                const index = debts.findIndex(item => item.phase === phase && Number(item.dueRound) === round);
                if (index < 0) return;
                debts.splice(index, 1);
                lib.skill.xd_wulan.sync(owner);
                trigger.cancel();
                game.log(owner, "跳过了已于三轮前由【舞阑】预先执行的", "#y" + lib.skill.xd_wulan.phaseLabel(phase));
                return;
              }

              const turnPlayer = trigger.player;
              const phaseNumber = Number(game.phaseNumber) || 0;
              for (const owner of engine.allPlayers()) {
                const list = lib.skill.xd_wulan.ensurePending(owner);
                const ready = list.filter(item => Number(item.phaseNumber) === phaseNumber && item.turnPlayer === (turnPlayer?.playerid || null));
                if (!ready.length) continue;
                owner.storage.xd_wulan_pending = list.filter(item => !ready.includes(item));
                lib.skill.xd_wulan.sync(owner);
                // 同一回合若多次发动【舞阑】，每次“令”都独立结算；前一次可能已用尽曲兴牌。
                for (let i = 0; i < ready.length; i++) await engine.resolveTurnEnd(owner);
              }
            }
          },
          xd_wulan_effect: {
            charlotte: true,
            forced: true,
            popup: false
          },

          // 王莽
          xd_qingding: {
            locked: true,
            forced: true,
            firstDo: true,
            trigger: {
              player: ["drawBegin", "recoverBegin"],
              source: "damageBegin1"
            },
            init(player) {
              lib.skill.xd_qingding.getState(player);
            },
            getState(player) {
              const round = Math.max(0, Math.floor(Number(game.roundNumber) || 0));
              let state = player.storage.xd_qingding_state;
              if (!state || typeof state !== "object") {
                state = player.storage.xd_qingding_state = {
                  round,
                  seen: [],
                  usedTurn: null
                };
              }
              if (state.round !== round) {
                state.round = round;
                state.seen = [];
              }
              if (!Array.isArray(state.seen)) state.seen = [];
              state.seen = state.seen.filter(item => ["draw", "recover", "damage"].includes(item)).toUniqued();
              return state;
            },
            getTurnKey() {
              const phase = _status.currentPhase;
              return String(Number(game.phaseNumber) || 0) + ":" + (phase?.playerid || "none");
            },
            getKind(event) {
              if (!event) return null;
              if (event.name === "draw") return "draw";
              if (event.name === "recover") return "recover";
              if (event.name === "damage") return "damage";
              return null;
            },
            sync(player) {
              if (typeof player.syncStorage === "function") {
                player.syncStorage("xd_qingding_state");
                player.syncStorage("xd_qingding_transgressed");
              }
            },
            snapshot(event, kind) {
              const data = {
                kind,
                num: Math.max(0, Math.floor(Number(event.num) || 0))
              };
              if (kind === "draw") {
                data.source = event.source;
                for (const key of ["bottom", "visible", "animate", "nodelay", "drawDeck", "gaintag"]) {
                  if (event[key] !== undefined) data[key] = event[key];
                }
              } else if (kind === "recover") {
                data.source = event.source;
                data.card = event.card;
                data.cards = Array.isArray(event.cards) ? event.cards.slice() : event.cards;
              } else if (kind === "damage") {
                data.target = event.player;
                data.source = event.source;
                data.nature = event.nature;
                data.natures = Array.isArray(event.natures) ? event.natures.slice() : event.natures;
                data.card = event.card;
                data.cards = Array.isArray(event.cards) ? event.cards.slice() : event.cards;
              }
              return data;
            },
            filter(event, player) {
              const skill = lib.skill.xd_qingding;
              const state = skill.getState(player);
              if (state.usedTurn === skill.getTurnKey()) return false;
              const kind = skill.getKind(event);
              if (!kind || !(Number(event.num) > 0)) return false;
              if (kind === "damage" && event.source !== player) return false;
              return true;
            },
            content(event, trigger, player) {
              const skill = lib.skill.xd_qingding;
              const state = skill.getState(player);
              const kind = skill.getKind(trigger);
              if (!kind) return;

              // “每回合限一次”限制的是【倾鼎】本身。即使这次没有命中三个分支中的
              // 实际效果，也已经耗尽本回合的发动次数；这正是窃取第三足所需的窗口。
              state.usedTurn = skill.getTurnKey();

              if (!player.storage.xd_qingding_transgressed && state.seen.length === 3) {
                // 三足已经在本轮凑齐；待这次行为真正完成后，才算成功“僭越”。
                trigger._xd_qingding_transgress = player.playerid;
                skill.sync(player);
                return;
              }

              if (!player.storage.xd_qingding_transgressed) {
                const others = ["draw", "recover", "damage"].filter(item => item !== kind);
                if (others.every(item => state.seen.includes(item))) {
                  // 另两项已执行：第三足被【倾鼎】防止，不把它记入本轮历史。
                  trigger.cancel();
                  skill.sync(player);
                  return;
                }
              }

              const kindsAfterThis = new Set(state.seen);
              kindsAfterThis.add(kind);
              if (kindsAfterThis.size === 1) {
                // 只执行过这一项：原事件完成后，再完整执行一次同类操作。
                trigger._xd_qingding_repeat = {
                  owner: player.playerid,
                  data: skill.snapshot(trigger, kind)
                };
              }
              skill.sync(player);
            },
            group: "xd_qingding_after",
            subSkill: {
              after: {
                charlotte: true,
                forced: true,
                silent: true,
                popup: false,
                trigger: {
                  player: ["drawAfter", "recoverAfter"],
                  source: "damageSource"
                },
                filter(event, player) {
                  const kind = lib.skill.xd_qingding.getKind(event);
                  if (!kind) return false;
                  if (kind === "damage" && event.source !== player) return false;
                  return true;
                },
                async content(event, trigger, player) {
                  const skill = lib.skill.xd_qingding;
                  const state = skill.getState(player);
                  const kind = skill.getKind(trigger);
                  if (!state.seen.includes(kind)) state.seen.push(kind);

                  if (trigger._xd_qingding_transgress === player.playerid) {
                    player.storage.xd_qingding_transgressed = true;
                    delete trigger._xd_qingding_transgress;
                    skill.sync(player);
                    game.log(player, "成功僭越，【倾鼎】删除了", "#y；另两项，防止之；所有项，删除本行");
                  } else {
                    skill.sync(player);
                  }

                  const repeat = trigger._xd_qingding_repeat;
                  if (!repeat || repeat.owner !== player.playerid || !repeat.data || repeat.data.kind !== kind) return;
                  delete trigger._xd_qingding_repeat;
                  // 快照取自原操作刚进入对应 Begin 时机的参数；第二次操作重新进入
                  // 原生事件链，因此其他摸牌/回复/伤害修正也会像第一次一样重新生效。
                  const data = repeat.data;
                  if (!(data.num > 0)) return;

                  if (data.kind === "draw") {
                    const next = player.draw(data.num);
                    next.source = data.source;
                    for (const key of ["bottom", "visible", "animate", "nodelay", "drawDeck", "gaintag"]) {
                      if (data[key] !== undefined) next[key] = data[key];
                    }
                    await next;
                    return;
                  }

                  if (data.kind === "recover") {
                    const next = player.recover(data.num);
                    next.source = data.source;
                    next.card = data.card;
                    if (data.cards !== undefined) next.cards = Array.isArray(data.cards) ? data.cards.slice() : data.cards;
                    await next;
                    return;
                  }

                  if (data.kind === "damage" && data.target) {
                    const next = data.target.damage(data.num, data.nature, data.source || player);
                    next.source = data.source || player;
                    if (data.natures !== undefined) next.natures = Array.isArray(data.natures) ? data.natures.slice() : data.natures;
                    next.card = data.card;
                    if (data.cards !== undefined) next.cards = Array.isArray(data.cards) ? data.cards.slice() : data.cards;
                    await next;
                  }
                }
              }
            }
          },
          // 荀灌
          xd_yuwei: {
            enable: "chooseToUse",
            position: "he",
            selectCard: 1,
            discard: false,
            lose: false,
            delay: false,
            log: false,
            mark: true,
            marktext: "围",
            init(player) {
              lib.skill.xd_yuwei.getState(player);
              lib.skill.xd_yuwei.updateTip(player);
            },
            onremove(player, skill) {
              delete player.storage.xd_yuwei_state;
              player.removeTip(skill);
            },
            getState(player) {
              let state = player.storage.xd_yuwei_state;
              if (!state || typeof state !== "object") {
                state = player.storage.xd_yuwei_state = {
                  phase: "ready",
                  x: 0,
                  used: 0,
                  turns: 0
                };
              }
              if (!["ready", "resolving", "disabled"].includes(state.phase)) state.phase = "ready";
              state.x = Math.max(0, Math.floor(Number(state.x) || 0));
              state.used = Math.max(0, Math.floor(Number(state.used) || 0));
              state.turns = Math.max(0, Math.floor(Number(state.turns) || 0));
              return state;
            },
            sync(player) {
              if (typeof player.syncStorage === "function") player.syncStorage("xd_yuwei_state");
              lib.skill.xd_yuwei.updateTip(player);
              player.markSkill("xd_yuwei");
            },
            updateTip(player) {
              if (!player) return;
              const state = lib.skill.xd_yuwei.getState(player);
              let text = "逾围 可用";
              if (state.phase === "resolving") {
                text = "逾围 结算中";
              } else if (state.phase === "disabled") {
                text = "逾围 失效<br>还需使用" + Math.max(0, state.x - state.used) + "张牌<br>已失效" + state.turns + "/" + state.x + "回合";
              }
              lib.xd_utils.updateTip(player, "xd_yuwei", text);
            },
            intro: {
              nocount: true,
              content(storage, player) {
                const state = lib.skill.xd_yuwei.getState(player);
                if (state.phase === "ready") {
                  return state.x > 0 ? "【逾围】可用。<br>上一张以移出方式使用的牌点数：" + state.x : "【逾围】可用。<br>尚无X。";
                }
                if (state.phase === "resolving") return "本次【逾围】正在结算。";
                return "【逾围】当前失效。<br>本次X：" + state.x + "<br>已使用牌：" + state.used + "/" + state.x + "<br>已经过角色回合：" + state.turns + "/" + state.x;
              }
            },
            getChooseToUseEvent() {
              let current = _status.event;
              while (current) {
                if (current.name === "chooseToUse") return current;
                current = current.getParent?.();
              }
              return null;
            },
            canUseMaterial(card, player) {
              if (!card || !player.getCards("he").includes(card)) return false;
              const x = Number(get.number(card, player));
              return Number.isFinite(x) && x > 0;
            },
            filter(event, player) {
              const state = lib.skill.xd_yuwei.getState(player);
              if (state.phase !== "ready" || !event || event.responded) return false;
              // 这里只决定【逾围】按钮是否可以进入。不要在技能自己的选牌阶段
              // 再用外层 chooseToUse.filterCard 去预筛实体牌，否则会把 viewAs 前的
              // 实体牌错误过滤掉。最终能否使用、能否选择目标继续交给原生流程判断。
              return player.getCards("he").some(card => lib.skill.xd_yuwei.canUseMaterial(card, player));
            },
            filterCard(card, player) {
              const state = lib.skill.xd_yuwei.getState(player);
              return state.phase === "ready" && lib.skill.xd_yuwei.canUseMaterial(card, player);
            },
            viewAs(cards, player) {
              if (cards.length !== 1) return null;
              // 不改变牌名、花色、点数或属性；这里只借 chooseToUse 建立主动技能入口。
              return new lib.element.VCard(cards[0], [], undefined, undefined, player);
            },
            prompt: "以移出方式使用一张牌",
            check(card) {
              const player = get.event().player;
              const x = Math.max(0, Math.floor(Number(get.number(card, player)) || 0));
              const handAfter = Math.max(0, player.countCards("h") - (player.getCards("h").includes(card) ? 1 : 0));
              const drawGain = Math.max(0, x - handAfter);
              return player.getUseValue(card) + drawGain * 1.5 - get.value(card, player) * 0.15;
            },
            ai: {
              order(item, player) {
                const cards = player.getCards("he").filter(card => {
                  const x = Number(get.number(card, player));
                  return Number.isFinite(x) && x > 0 && player.hasUseTarget?.(card);
                });
                if (!cards.length) return 1;
                return Math.max(...cards.map(card => get.order(card))) + 0.05;
              },
              result: {
                player: 1
              }
            },
            group: ["xd_yuwei_resolve", "xd_yuwei_count", "xd_yuwei_turn"],
            subSkill: {
              resolve: {
                charlotte: true,
                trigger: {
                  player: "useCardBefore"
                },
                forced: true,
                popup: false,
                filter(event, player) {
                  const state = lib.skill.xd_yuwei.getState(player);
                  if (state.phase !== "ready") return false;
                  if (event.skill !== "xd_yuwei" && event.card?.skill !== "xd_yuwei") return false;
                  if (!Array.isArray(event.cards) || event.cards.length !== 1) return false;
                  const material = event.cards[0];
                  if (get.itemtype(material) !== "card") return false;
                  const x = Number(get.number(material, player));
                  return Number.isFinite(x) && x > 0;
                },
                async content(event, trigger, player) {
                  const skill = lib.skill.xd_yuwei, u = lib.xd_utils;
                  const material = trigger.cards?.[0];
                  if (!material) return;
                  const x = Math.max(0, Math.floor(Number(get.number(material, player)) || 0));
                  if (x <= 0) return;

                  // 点下【逾围】并完成本次用牌选择后，才真正发动；不再额外询问一次。
                  const state = skill.getState(player);
                  state.phase = "resolving";
                  state.x = x;
                  state.used = 0;
                  state.turns = 0;
                  skill.sync(player);
                  player.logSkill("xd_yuwei");

                  // “以移出方式使用”：先发生真实的移出，再让本次 useCard 按原生流程继续结算。
                  const moved = await u.moveOut(player, [material], {
                    group: "xd_yuwei",
                    faceUp: true,
                    source: player,
                    animate: "gain2"
                  });
                  if (!moved.includes(material)) {
                    state.phase = "ready";
                    skill.sync(player);
                    return;
                  }

                  // 发动【逾围】的这一张不计入随后要求的“使用X张牌”。
                  trigger._xd_yuwei_activation = true;
                  trigger._xd_yuwei_material = material;

                  // 基本牌/普通锦囊的实体牌留在移出区，只让虚拟用牌对象继续完成效果；
                  // 装备牌、延时锦囊则保留实体材料，供原生 useCard 后续移入装备区/判定区。
                  const type = get.type(trigger.card, null, false);
                  if (type !== "equip" && type !== "delay") {
                    trigger.cards = (trigger.cards || []).filter(card => card !== material);
                    if (Array.isArray(trigger.card?.cards)) {
                      trigger.card.cards = trigger.card.cards.filter(card => card !== material);
                    }
                  }

                  await player.drawTo(x);
                  if (!player.isIn() || !player.hasSkill("xd_yuwei")) return;

                  // 必须等“摸牌至X张”完成后，才开始计算后续X次用牌与X个角色回合。
                  state.phase = "disabled";
                  state.used = 0;
                  state.turns = 0;
                  skill.sync(player);
                }
              },
              count: {
                trigger: {
                  player: "useCardAfter"
                },
                forced: true,
                popup: false,
                async content(event, trigger, player) {
                  const skill = lib.skill.xd_yuwei, u = lib.xd_utils;
                  const material = trigger._xd_yuwei_material;
                  if (material && !player.getExpansions(u.movedOutTag).includes(material)) {
                    // 装备/延时锦囊已经由移出区进入正常区域，清掉仅属于“移出牌”的旧标签/顺序记录。
                    u.forgetMovedOut(player, [material]);
                  }
                  const state = skill.getState(player);
                  if (state.phase !== "disabled" || trigger._xd_yuwei_activation) return;
                  state.used++;
                  if (state.used >= state.x) {
                    state.phase = "ready";
                    state.used = state.x;
                    state.turns = 0;
                    game.log(player, "已使用", state.x, "张牌，【逾围】恢复生效");
                  }
                  skill.sync(player);
                }
              },
              turn: {
                trigger: {
                  global: "phaseAfter"
                },
                forced: true,
                popup: false,
                filter(event, player) {
                  const state = lib.skill.xd_yuwei.getState(player);
                  return state.phase === "disabled" && state.x > 0;
                },
                async content(event, trigger, player) {
                  const skill = lib.skill.xd_yuwei;
                  const state = skill.getState(player);
                  if (state.phase !== "disabled") return;
                  state.turns++;
                  if (state.turns >= state.x) {
                    game.log(player, "的【逾围】失效已达", state.x, "个角色回合，失去了该技能");
                    await player.removeSkills("xd_yuwei");
                    return;
                  }
                  skill.sync(player);
                }
              }
            }
          },
          // 班超
          xd_longsha: {
            forced: true,
            locked: true,
            trigger: {
              player: "useCardAfter"
            },
            mark: true,
            marktext: "沙",
            intro: {
              markcount(storage, player) {
                return lib.xd_utils.getMovedOutCards(player).length;
              },
              mark(dialog, content, player) {
                const cards = lib.xd_utils.getMovedOutCards(player);
                const x = player.countCards("h") / 2;
                dialog.addText("当前X=" + x + "（手牌数的一半）");
                if (!cards.length) {
                  dialog.addText("当前没有移出牌");
                  return;
                }
                dialog.addText("移出牌（由先至后）");
                dialog.addAuto(cards);
              }
            },
            getX(player) {
              return player.countCards("h") / 2;
            },
            getRecentUsedCards(player, num) {
              if (!Number.isInteger(num) || num <= 0) return [];
              const history = player.getAllHistory("useCard", evt => !!evt.card);
              if (history.length < num) return [];
              return history.slice(-num).map(evt => evt.card);
            },
            sequenceMatches(a, b, player) {
              if (a.length !== b.length || !a.length) return false;
              const sameSuit = a.every((card, i) => get.suit(card, player) === get.suit(b[i], player));
              if (sameSuit) return true;
              return a.every((card, i) => get.type2(card, player) === get.type2(b[i], player));
            },
            getRecastWindows(player) {
              const skill = lib.skill.xd_longsha, x = skill.getX(player);
              // “连续X张”要求张数恰为X；2.5之类的小数不能偷偷取整。X=0也不视为可重铸0张。
              if (!Number.isInteger(x) || x <= 0) return [];
              const recent = skill.getRecentUsedCards(player, x);
              if (recent.length !== x) return [];
              const moved = lib.xd_utils.getMovedOutCards(player);
              if (moved.length < x) return [];
              const windows = [];
              for (let i = 0; i <= moved.length - x; i++) {
                const cards = moved.slice(i, i + x);
                if (!cards.every(card => player.canRecast(card))) continue;
                if (skill.sequenceMatches(cards, recent, player)) windows.push({ start: i, cards });
              }
              return windows;
            },
            filter(event, player) {
              const moved = lib.xd_utils.getMovedOutCards(player);
              if (moved.length) return true; // 至少可以进入“移去一张牌”的否则项。
              const x = lib.skill.xd_longsha.getX(player);
              // “至多X张”仍只能选择整数张；第一张只有在1<=X时才可移出。
              return x >= 1 && player.countCards("he") > 0;
            },
            async content(event, trigger, player) {
              const u = lib.xd_utils, skill = lib.skill.xd_longsha;
              // 每次结算前先清理可能已因其他效果离开武将牌的旧顺序记录。
              u.refreshMovedOutState(player, true);

              // 1. 交任务：能重铸匹配的连续X张移出牌，就必须执行，并且不进入后续“否则”。
              let windows = skill.getRecastWindows(player);
              if (windows.length) {
                let chosen = windows[0];
                if (windows.length > 1) {
                  const list = windows.map((item, i) => [
                    String(i),
                    "第" + get.cnNumber(item.start + 1, true) + "至第" + get.cnNumber(item.start + item.cards.length, true) + "张：" + get.translation(item.cards)
                  ]);
                  const result = await player.chooseButton([
                    "###龙沙###选择要重铸的一段连续移出牌",
                    [list, "textbutton"]
                  ], true).set("displayIndex", false).set("ai", button => {
                    const item = windows[Number(button.link)];
                    return item ? -item.cards.reduce((sum, card) => sum + get.value(card, player), 0) : 0;
                  }).forResult();
                  if (result?.bool && result.links?.length) chosen = windows[Number(result.links[0])] || chosen;
                }
                const cards = chosen.cards.slice();
                await player.recast(cards);
                u.forgetMovedOut(player, cards);
                player.markSkill("xd_longsha");
                return;
              }

              // 2. 改任务：只有第一项无法执行时才进入；只要仍有移出牌，就必须移去其中一张。
              let moved = u.getMovedOutCards(player);
              if (moved.length) {
                let card = moved[0];
                if (moved.length > 1) {
                  const result = await player.chooseButton([
                    "###龙沙###移去一张移出牌",
                    [moved, "card"]
                  ], true).set("ai", button => 10 - get.value(button.link, player)).forResult();
                  if (result?.bool && result.links?.length) card = result.links[0];
                }
                await u.removeMovedOut(player, [card]);
                player.markSkill("xd_longsha");
                return;
              }

              // 3. 发任务：前两项均无法执行时，逐张移出。X在每一张真正移出后都会随手牌数立刻变化。
              // 判断“还能否再移一张”时使用 当前已移出数+1 <= 当前X；因此X=2.5时最多只能移2张。
              let movedCount = 0;
              while (player.isIn()) {
                const x = skill.getX(player);
                if (movedCount + 1 > x || player.countCards("he") <= 0) break;
                const first = movedCount === 0;
                const prompt = "【龙沙】：依次移出至多X张牌（当前X=" + x + "，本次已移出" + movedCount + "张）" + (first ? "" : "；你可以取消以停止继续移出");
                const result = await player.chooseCard({
                  position: "he",
                  selectCard: 1,
                  forced: first,
                  prompt
                }).set("ai", card => (first ? 10 : 7) - get.value(card, player)).forResult();
                if (!result?.bool || !result.cards?.length) break;
                const added = await u.moveOut(player, [result.cards[0]], {
                  group: "xd_longsha",
                  faceUp: true,
                  source: player,
                  animate: "gain2"
                });
                if (!added.length) break;
                movedCount += added.length;
                player.markSkill("xd_longsha");
              }
              if (movedCount > 0) await player.draw(movedCount);
            },
            ai: {
              threaten: 1.2
            }
          },
          // 谢安
          xd_buping: {
            enable: "chooseToUse",
            mark: true,
            marktext: "枰",
            init(player) {
              lib.skill.xd_buping.getState(player);
            },
            onremove(player) {
              delete player.storage.xd_buping_state;
            },
            getState(player) {
              let state = player.storage.xd_buping_state;
              if (!state || typeof state !== "object") {
                state = player.storage.xd_buping_state = {
                  x: 0,
                  round: game.roundNumber ?? 0,
                  used: 0
                };
              }
              state.x = Math.max(0, Math.floor(Number(state.x) || 0));
              const round = game.roundNumber ?? 0;
              if (state.round !== round) {
                state.round = round;
                state.used = 0;
              }
              state.used = Math.max(0, Math.floor(Number(state.used) || 0));
              return state;
            },
            getX(player) {
              return lib.skill.xd_buping.getState(player).x;
            },
            getLegalVCards(event, player) {
              // 【布枰】既可以在出牌阶段主动发动，也可以介入其他 chooseToUse 询问。
              // event.type === "phase" 正是普通出牌阶段的 chooseToUse，不应排除。
              if (!event || event.responded || typeof event.filterCard !== "function") return [];
              return get.inpileVCardList(info => {
                const card = get.autoViewAs({
                  name: info[2],
                  nature: info[3],
                  isCard: true
                }, "unsure");
                try {
                  return event.filterCard(card, player, event);
                } catch (e) {
                  return false;
                }
              });
            },
            filter(event, player) {
              const state = lib.skill.xd_buping.getState(player);
              if (event.responded || state.used >= state.x + 1) return false;
              if (!game.hasPlayer(current => current !== player && current.isIn())) return false;
              return lib.skill.xd_buping.getLegalVCards(event, player).length > 0;
            },
            chooseButton: {
              dialog(event, player) {
                const list = lib.skill.xd_buping.getLegalVCards(event, player);
                return lib.xd_utils.createCardNameCatalogDialog(
                  "布枰：选择你需要使用的牌",
                  list,
                  { intro: "【布枰】只显示当前时机可以合法使用的牌。先选具体牌名；随后按无名杀原生流程选择这张牌的目标，再指定一名其他角色替你提供对应实体牌。实体牌来自对方，但这张牌的使用者仍是谢安。" }
                );
              },
              filter(button, player) {
                const event = _status.event.getParent();
                if (!event || typeof event.filterCard !== "function" || !Array.isArray(button.link)) return false;
                const card = get.autoViewAs({
                  name: button.link[2],
                  nature: button.link[3],
                  isCard: true
                }, "unsure");
                try {
                  return event.filterCard(card, player, event);
                } catch (e) {
                  return false;
                }
              },
              check(button) {
                const player = get.player();
                const card = {
                  name: button.link[2],
                  nature: button.link[3],
                  isCard: true
                };
                return player.getUseValue(card);
              },
              backup(links) {
                const link = links[0] || [];
                return {
                  filterCard: () => false,
                  selectCard: -1,
                  popname: true,
                  log: false,
                  sourceSkill: "xd_buping",
                  viewAs: {
                    name: link[2] || "sha",
                    nature: link[3],
                    isCard: true
                  }
                };
              },
              prompt(links) {
                const link = links[0] || [];
                const card = {
                  name: link[2] || "sha",
                  nature: link[3],
                  isCard: true
                };
                return "发动【布枰】，令其他角色替你提供" + get.translation(card) + "；请选择此牌的目标";
              }
            },
            hiddenCard(player, name) {
              const event = _status.event;
              if (!event || event.name !== "chooseToUse") return false;
              const state = lib.skill.xd_buping.getState(player);
              if (state.used >= state.x + 1 || !game.hasPlayer(current => current !== player && current.isIn())) return false;
              return lib.skill.xd_buping.getLegalVCards(event, player).some(info => info[2] === name);
            },
            intro: {
              markcount(storage, player) {
                return lib.skill.xd_buping.getX(player);
              },
              content(storage, player) {
                const state = lib.skill.xd_buping.getState(player);
                return "历史最大重复次数X=" + state.x + "<br>本轮已发动：" + state.used + "/" + (state.x + 1);
              }
            },
            group: "xd_buping_supply",
            subSkill: {
              backup: {},
              supply: {
                charlotte: true,
                trigger: {
                  player: "useCardBegin"
                },
                forced: true,
                popup: false,
                filter(event) {
                  return event.skill === "xd_buping_backup" || event.skill === "xd_buping";
                },
                async content(event, trigger, player) {
                  const skill = lib.skill.xd_buping;
                  const outer = trigger.getParent();
                  const state = skill.getState(player);
                  // 真正确认了一次【布枰】用牌后才消耗本轮次数；取消选牌/目标不会消耗。
                  state.used++;
                  player.markSkill("xd_buping");
                  player.logSkill("xd_buping");

                  const need = {
                    name: trigger.card?.name,
                    nature: trigger.card?.nature,
                    isCard: true
                  };
                  const specified = [];
                  let repeats = 0;
                  let current = null;

                  const chooseNext = async first => {
                    const result = await player.chooseTarget({
                      prompt: first ? "【布枰】：选择一名其他角色替你提供" + get.translation(need) : "【布枰】：选择一名本次技能尚未指定的其他角色重复此流程",
                      forced: true,
                      filterTarget(card, player, target) {
                        return target !== player && target.isIn() && !get.event().specified.includes(target);
                      },
                      ai(target) {
                        const player = get.player();
                        return get.attitude(player, target) + Math.min(3, target.countCards("hs") / 2);
                      }
                    }).set("specified", specified).forResult();
                    return result?.bool && result.targets?.length ? result.targets[0] : null;
                  };

                  current = await chooseNext(true);
                  if (!current) {
                    trigger.cancel();
                    if (outer && typeof outer.goto === "function") outer.goto(0);
                    return;
                  }

                  while (current && player.isIn()) {
                    specified.push(current);
                    player.line(current);
                    const next = current.chooseToRespond({
                      prompt: "【布枰】：是否替" + get.translation(player) + "提供" + get.translation(need) + "？",
                      filterCard(card, target) {
                        const need = get.event().xd_buping_need;
                        if (!need || get.name(card, target) !== need.name) return false;
                        const actualNature = get.nature(card, target) || null;
                        const needNature = need.nature || null;
                        if (actualNature !== needNature) return false;
                        return lib.filter.cardRespondable(card, target);
                      },
                      ai(card) {
                        const event = get.event();
                        const source = event.source;
                        return get.attitude(event.player, source) - get.value(card, event.player) / 8;
                      }
                    });
                    next.set("source", player);
                    next.set("xd_buping_need", need);
                    next.noOrdering = true;
                    const result = await next.forResult();

                    if (result?.bool && result.card) {
                      // 仿照【激将】：实体牌由被指定角色提供，但最终 useCard 的使用者仍是谢安。
                      trigger.card = result.card;
                      trigger.cards = result.cards || [];
                      trigger.throw = false;
                      game.log(current, "替", player, "提供了", result.card);
                      await current.draw();
                      if (player.isIn()) await player.draw();
                      return;
                    }

                    const x = skill.getX(player);
                    const canDiscard = x === 0 || player.countDiscardableCards(player, "he") >= x;
                    const canRepeat = game.hasPlayer(target => target !== player && target.isIn() && !specified.includes(target));
                    let repeat = false;

                    if (canDiscard && canRepeat) {
                      const controls = ["弃置" + x + "张牌并结束", "重复此流程"];
                      const choice = await player.chooseControl(controls).set("prompt", "【布枰】：" + get.translation(current) + "未替你提供" + get.translation(need)).set("ai", () => {
                        const player = get.player();
                        const x = lib.skill.xd_buping.getX(player);
                        if (x === 0) return 0;
                        const value = player.getCards("he").sort((a, b) => get.value(a, player) - get.value(b, player)).slice(0, x).reduce((sum, card) => sum + get.value(card, player), 0);
                        return value > 10 ? 1 : 0;
                      }).forResult();
                      repeat = choice.control === controls[1];
                    } else if (canRepeat) {
                      repeat = true;
                    }

                    if (!repeat) {
                      if (canDiscard && x > 0) {
                        await player.chooseToDiscard({
                          position: "he",
                          selectCard: x,
                          forced: true,
                          prompt: "【布枰】：弃置" + x + "张牌"
                        }).forResult();
                      } else if (!canDiscard) {
                        game.log(player, "无法弃置", "#y" + x, "张牌，且本次【布枰】已无可重复指定的角色");
                      }
                      trigger.cancel();
                      if (outer && typeof outer.goto === "function") outer.goto(0);
                      return;
                    }

                    const target = await chooseNext(false);
                    if (!target) {
                      trigger.cancel();
                      if (outer && typeof outer.goto === "function") outer.goto(0);
                      return;
                    }
                    repeats++;
                    if (repeats > state.x) {
                      state.x = repeats;
                      player.markSkill("xd_buping");
                      game.log(player, "的【布枰】历史最大重复次数X变为", "#y" + state.x);
                    }
                    current = target;
                  }

                  trigger.cancel();
                  if (outer && typeof outer.goto === "function") outer.goto(0);
                }
              }
            },
            ai: {
              order: 8,
              result: {
                player: 1
              }
            }
          },
          xd_zhenwu: {
            forced: true,
            locked: true,
            init(player) {
              player.storage.xd_zhenwu_active = false;
              player.storage.xd_zhenwu_cards = {};
            },
            onremove(player) {
              delete player.storage.xd_zhenwu_active;
              delete player.storage.xd_zhenwu_cards;
            },
            needsBasic(event, player) {
              if (!event || event.name !== "chooseToUse" || event.type === "phase" || event.responded || typeof event.filterCard !== "function") return false;
              return get.inpileVCardList(info => {
                const card = get.autoViewAs({
                  name: info[2],
                  nature: info[3],
                  isCard: true
                }, "unsure");
                if (get.type(card, null, false) !== "basic") return false;
                try {
                  return event.filterCard(card, player, event);
                } catch (e) {
                  return false;
                }
              }).length > 0;
            },
            group: ["xd_zhenwu_phase", "xd_zhenwu_activate", "xd_zhenwu_double", "xd_zhenwu_record", "xd_zhenwu_cleanup"],
            subSkill: {
              phase: {
                charlotte: true,
                trigger: {
                  player: "phaseUseBegin"
                },
                firstDo: true,
                forced: true,
                popup: false,
                filter(event, player) {
                  return !player.storage.xd_zhenwu_active;
                },
                content(event, trigger, player) {
                  // 进入出牌阶段后即视为已经处于“可以/需要使用基本牌”的窗口。
                  // 因而【镇物】从此刻起生效；摸牌阶段此前摸到的牌不受影响。
                  player.storage.xd_zhenwu_active = true;
                  player.storage.xd_zhenwu_cards = {};
                  player.logSkill("xd_zhenwu");
                  game.log("本回合此后所有角色的摸牌受【镇物】影响");
                }
              },
              activate: {
                charlotte: true,
                trigger: {
                  player: "chooseToUseBefore"
                },
                firstDo: true,
                forced: true,
                popup: false,
                filter(event, player) {
                  return !player.storage.xd_zhenwu_active && lib.skill.xd_zhenwu.needsBasic(event, player);
                },
                content(event, trigger, player) {
                  player.storage.xd_zhenwu_active = true;
                  player.storage.xd_zhenwu_cards = {};
                  player.logSkill("xd_zhenwu");
                  game.log("本回合此后所有角色的摸牌受【镇物】影响");
                }
              },
              double: {
                charlotte: true,
                trigger: {
                  global: "drawBegin"
                },
                lastDo: true,
                forced: true,
                silent: true,
                popup: false,
                forceDie: true,
                filter(event, player) {
                  if (!player.storage.xd_zhenwu_active || !event.player || !(event.num > 0)) return false;
                  return !event._xd_zhenwu_doubled_by?.includes(player.playerid);
                },
                content(event, trigger, player) {
                  trigger._xd_zhenwu_doubled_by ??= [];
                  trigger._xd_zhenwu_doubled_by.push(player.playerid);
                  trigger.num *= 2;
                }
              },
              record: {
                charlotte: true,
                trigger: {
                  global: "gainAfter"
                },
                firstDo: true,
                forced: true,
                silent: true,
                popup: false,
                forceDie: true,
                filter(event, player) {
                  if (!player.storage.xd_zhenwu_active || !event.player || !event.cards?.length) return false;
                  const parent = event.getParent?.();
                  return parent?.name === "draw";
                },
                async content(event, trigger, player) {
                  const target = trigger.player;
                  const cards = (trigger.cards || []).filter(Boolean);
                  const ids = cards.map(card => card.cardid).filter(Boolean);
                  if (ids.length) {
                    const store = player.storage.xd_zhenwu_cards ??= {};
                    const key = target.playerid;
                    store[key] ??= [];
                    for (const id of ids) if (!store[key].includes(id)) store[key].push(id);
                  }
                  const hand = cards.filter(card => target.getCards("h").includes(card));
                  if (hand.length) await lib.xd_utils.revealHandCards(target, hand, "visible_xd_zhenwu", "因【镇物】明置");
                }
              },
              cleanup: {
                charlotte: true,
                trigger: {
                  global: "phaseAfter"
                },
                lastDo: true,
                forced: true,
                silent: true,
                popup: false,
                forceDie: true,
                filter(event, player) {
                  return !!player.storage.xd_zhenwu_active;
                },
                async content(event, trigger, player) {
                  const store = player.storage.xd_zhenwu_cards || {};
                  const all = game.players.concat(game.dead);
                  for (const [id, list] of Object.entries(store)) {
                    const target = all.find(current => current.playerid === id);
                    if (!target || !list?.length) continue;
                    const ids = new Set(list);
                    // 只弃置仍属于原摸牌角色的牌：即仍在其手牌区或装备区中的相关实体牌。
                    // 一旦离开手牌区/装备区（包括进入判定区），即不再视为该角色的牌，不再追缴。
                    const cards = target.getCards("he").filter(card => card.cardid && ids.has(card.cardid));
                    if (cards.length) await target.discard(cards);
                  }
                  player.storage.xd_zhenwu_active = false;
                  player.storage.xd_zhenwu_cards = {};
                }
              }
            }
          },
          // 刘秀
          xd_fuding: {
            enable: "chooseToUse",
            mark: true,
            marktext: "鼎",
            init(player) {
              player.storage.xd_fuding_required ??= [];
              lib.skill.xd_fuding.syncState(player);
            },
            onremove(player) {
              delete player.storage.xd_fuding_required;
              player.removeTip("xd_fuding");
            },
            itemNames: {
              number: "手牌数为某底牌点数",
              hp: "体力值为某底牌字数",
              legal: "为各底牌的合法目标"
            },
            allItems: ["number", "hp", "legal"],
            itemName(item) {
              return lib.skill.xd_fuding.itemNames[item] || item;
            },
            getRequired(player) {
              const allowed = new Set(lib.skill.xd_fuding.allItems);
              const current = Array.isArray(player.storage.xd_fuding_required) ? player.storage.xd_fuding_required : [];
              return player.storage.xd_fuding_required = current.filter(item => allowed.has(item));
            },
            syncState(player) {
              const skill = lib.skill.xd_fuding;
              const required = skill.getRequired(player);
              player.syncStorage("xd_fuding_required");
              player.markSkill("xd_fuding");
              lib.xd_utils.updateTip(
                player,
                "xd_fuding",
                required.length ? "扶鼎｜下次须 " + required.map(item => ({ number: "点", hp: "字", legal: "标" })[item]).join("+") : "扶鼎｜当前无下次用牌限制"
              );
            },
            intro: {
              markcount(storage, player) {
                return lib.skill.xd_fuding.getRequired(player).length;
              },
              content(storage, player) {
                const skill = lib.skill.xd_fuding;
                const required = skill.getRequired(player);
                if (!required.length) return "当前无下次使用牌的目标限制";
                return "下次使用牌的所有目标须同时满足：<br>" + required.map((item, index) => (index + 1) + ". " + skill.itemName(item)).join("<br>");
              }
            },
            isImmediate(card) {
              const type = get.type(card, null, false);
              return type === "basic" || type === "trick";
            },
            getLegalVCards(event, player) {
              if (!event || event.name !== "chooseToUse" || event.responded || typeof event.filterCard !== "function") return [];
              return get.inpileVCardList(info => {
                const card = get.autoViewAs({
                  name: info[2],
                  nature: info[3],
                  isCard: true
                }, "unsure");
                if (!lib.skill.xd_fuding.isImmediate(card)) return false;
                try {
                  return !!event.filterCard(card, player, event);
                } catch (e) {
                  return false;
                }
              });
            },
            filter(event, player) {
              if (!player.countCards("he")) return false;
              return lib.skill.xd_fuding.getLegalVCards(event, player).length > 0;
            },
            getBottomCards(card, event, player) {
              // “底牌”只认本次使用牌依托的原实体牌。优先 useCard.cards；
              // 目标选择阶段尚未生成 useCard 时，再读取虚拟牌 cards / 当前已选实体牌。
              const sources = [event?.cards, card?.cards];
              if (player && _status.event?.player === player && Array.isArray(ui.selected?.cards) && ui.selected.cards.length) {
                sources.push(ui.selected.cards);
              }
              sources.push([card]);
              for (const source of sources) {
                let cards;
                try {
                  cards = Array.from(source ?? []);
                } catch (e) {
                  continue;
                }
                cards = [...new Set(cards.filter(current => current && get.itemtype(current) === "card"))];
                if (cards.length) return cards;
              }
              return [];
            },
            getBottomName(card) {
              // 设计师所说“底牌”取原实体牌信息：优先直接读取实体牌自身的牌名，
              // 不把其他技能临时造成的 cardname/viewAs 当成底牌牌名。
              return typeof card?.name === "string" && card.name ? card.name : get.name(card);
            },
            getBottomRuleCard(bottom) {
              if (!bottom) return null;
              const name = lib.skill.xd_fuding.getBottomName(bottom);
              if (!name) return null;
              const data = {
                name,
                nature: bottom.nature,
                suit: bottom.suit,
                number: bottom.number,
                isCard: true
              };
              try {
                return get.autoViewAs(data, [bottom]);
              } catch (e) {
                return data;
              }
            },
            getNameLength(card, player) {
              const name = lib.skill.xd_fuding.getBottomName(card);
              if (!name) return 0;
              let text = lib.translate[name];
              if (typeof text !== "string" || !text.trim()) text = get.translation(name);
              if (typeof text !== "string") return 0;
              text = text.replace(/<br\s*\/?>/gi, "").replace(/<[^>]*>/g, "").replace(/[【】\[\]\s]/g, "").trim();
              return Array.from(text).length;
            },
            getBottomNumbers(bottoms, player) {
              return [...new Set((bottoms || []).map(card => {
                const raw = Number(card?.number);
                return Number.isFinite(raw) && raw > 0 ? raw : Number(get.number(card));
              }).filter(num => Number.isFinite(num) && num > 0))];
            },
            getBottomNameLengths(bottoms, player) {
              return [...new Set((bottoms || []).map(card => lib.skill.xd_fuding.getNameLength(card, player)).filter(num => num > 0))];
            },
            getCardTarget(event, player) {
              const finalName = get.name(event?.card, player) || event?.card?.name;
              if (!["shan", "wuxie"].includes(finalName)) return null;
              let current = event;
              let guard = 0;
              while (current && guard++ < 16) {
                const respondTo = current.respondTo;
                if (Array.isArray(respondTo) && respondTo[1]) return respondTo[1];
                let parent = null;
                try {
                  parent = typeof current.getParent === "function" ? current.getParent() : current.parent;
                } catch (e) {
                  parent = current.parent;
                }
                if (!parent || parent === current) break;
                if (finalName === "shan" && parent.card && get.name(parent.card, parent.player || player) === "sha") return parent.card;
                if (finalName === "wuxie" && parent.card && (parent.name === "_wuxie" || parent.name === "wuxie" || parent._wuxie)) return parent.card;
                current = parent;
              }
              return null;
            },
            getPlayerTargets(event, player) {
              const finalName = get.name(event?.card, player) || event?.card?.name;
              // 【闪】、【无懈可击】在本规则里以正在响应/抵消的“牌”为目标，而不是角色。
              if (["shan", "wuxie"].includes(finalName)) return [];
              return (Array.isArray(event?.targets) ? event.targets : []).filter(target => target && typeof target.countCards === "function");
            },
            bottomCanTargetPlayer(bottom, player, target) {
              if (!bottom || !player || !target) return false;
              const old = _status._xd_fuding_baseTargetCheck;
              _status._xd_fuding_baseTargetCheck = true;
              try {
                const ruleCard = lib.skill.xd_fuding.getBottomRuleCard(bottom) || bottom;
                // 第四参数 false：只判断“这个目标是否是该底牌的合法目标”，不让既往使用次数
                // 把【杀】等底牌整体判死；距离、目标禁制及牌本身的目标规则仍由本体处理。
                if (typeof player.canUse === "function") {
                  try {
                    return !!player.canUse(ruleCard, target, undefined, false);
                  } catch (e) {}
                }
                if (lib.filter && typeof lib.filter.targetEnabled2 === "function") {
                  try {
                    if (!lib.filter.targetEnabled2(ruleCard, player, target)) return false;
                    if (typeof lib.filter.targetInRange === "function" && !lib.filter.targetInRange(ruleCard, player, target)) return false;
                    return true;
                  } catch (e) {}
                }
                const info = get.info(ruleCard, false);
                if (info && typeof info.filterTarget === "function") {
                  try {
                    return !!info.filterTarget(ruleCard, player, target);
                  } catch (e) {}
                }
                return false;
              } finally {
                if (old === undefined) delete _status._xd_fuding_baseTargetCheck;
                else _status._xd_fuding_baseTargetCheck = old;
              }
            },
            bottomCanTargetCard(bottom, event, player, cardTarget) {
              if (!bottom || !cardTarget || !event?.card) return false;
              const finalName = get.name(event.card, player) || event.card.name;
              const bottomName = lib.skill.xd_fuding.getBottomName(bottom);
              // 当前本体里真正以“另一张牌”为目标且会进入 chooseToUse/useCard 的核心情况就是
              // 【闪】和【无懈可击】。若底牌本来就是同名牌，则当前已经合法的响应对象自然也是
              // 该底牌的合法目标；其他实体牌转化而来则不能借最终牌的目标规则冒充底牌规则。
              if (finalName === "shan") return bottomName === "shan";
              if (finalName === "wuxie") return bottomName === "wuxie";
              return false;
            },
            evaluate(event, player) {
              const skill = lib.skill.xd_fuding;
              const bottoms = skill.getBottomCards(event?.card, event, player);
              const players = skill.getPlayerTargets(event, player);
              const cardTarget = skill.getCardTarget(event, player);
              const numbers = skill.getBottomNumbers(bottoms, player);
              const lengths = skill.getBottomNameLengths(bottoms, player);
              const hasLogicalTarget = players.length > 0 || !!cardTarget;
              const number = players.length > 0 && numbers.length > 0 && players.every(target => numbers.includes(target.countCards("h")));
              const hp = players.length > 0 && lengths.length > 0 && players.every(target => lengths.includes(target.hp));
              let legal = bottoms.length > 0 && hasLogicalTarget;
              if (legal && players.length) {
                legal = players.every(target => bottoms.every(bottom => skill.bottomCanTargetPlayer(bottom, player, target)));
              }
              if (legal && cardTarget) {
                legal = bottoms.every(bottom => skill.bottomCanTargetCard(bottom, event, player, cardTarget));
              }
              return {
                bottoms,
                players,
                cardTarget,
                satisfied: { number, hp, legal }
              };
            },
            targetPasses(card, player, target, required) {
              const skill = lib.skill.xd_fuding;
              if (!required?.length) return true;
              const bottoms = skill.getBottomCards(card, null, player);
              // 某些 AI 预判发生在实体材料真正挂到虚拟牌之前；这里不凭空判死，
              // 最终仍会由 useCardBefore 的完整复核兜底。
              if (!bottoms.length) return true;
              if (required.includes("number")) {
                const numbers = skill.getBottomNumbers(bottoms, player);
                if (!numbers.includes(target.countCards("h"))) return false;
              }
              if (required.includes("hp")) {
                const lengths = skill.getBottomNameLengths(bottoms, player);
                if (!lengths.includes(target.hp)) return false;
              }
              if (required.includes("legal") && !bottoms.every(bottom => skill.bottomCanTargetPlayer(bottom, player, target))) return false;
              return true;
            },
            hasPlayerTarget(card, player) {
              const name = get.name(card, player) || card?.name;
              if (["shan", "wuxie"].includes(name)) return false;
              const info = get.info(card, false) || {};
              if (info.notarget) return false;
              try {
                const range = lib.filter.selectTarget(card, player);
                if (Array.isArray(range) && range[0] === 0 && range[1] === 0) return false;
              } catch (e) {}
              return true;
            },
            candidateEnabled(card, player) {
              if (_status._xd_fuding_baseTargetCheck) return;
              const skill = lib.skill.xd_fuding;
              const required = skill.getRequired(player);
              if (!required.length) return;
              if ((required.includes("number") || required.includes("hp")) && !skill.hasPlayerTarget(card, player)) return false;
              const name = get.name(card, player) || card?.name;
              if (required.includes("legal") && ["shan", "wuxie"].includes(name)) {
                const bottoms = skill.getBottomCards(card, null, player);
                if (bottoms.length && !bottoms.every(bottom => skill.getBottomName(bottom) === name)) return false;
              }
            },
            isFudingUse(event) {
              const name = event?.skill;
              if (name === "xd_fuding" || name === "xd_fuding_backup") return true;
              if (!name) return false;
              try {
                return get.info(name)?.sourceSkill === "xd_fuding";
              } catch (e) {
                return false;
              }
            },
            chooseButton: {
              dialog(event, player) {
                const list = lib.skill.xd_fuding.getLegalVCards(event, player);
                const required = lib.skill.xd_fuding.getRequired(player);
                const suffix = required.length ? "；你上次【扶鼎】尚余条件，本次用牌还必须先满足：" + required.map(item => lib.skill.xd_fuding.itemName(item)).join("、") : "";
                return lib.xd_utils.createCardNameCatalogDialog(
                  "扶鼎：选择要转化使用的即时牌",
                  list,
                  { intro: "先选择要使用的即时牌名，再选择至少一张手牌或装备牌作为底牌。底牌保留各自原实体牌的点数、牌名字数与原合法目标，用于判定【扶鼎】三项条件" + suffix + "。" }
                );
              },
              filter(button, player) {
                const event = _status.event.getParent();
                if (!event || typeof event.filterCard !== "function" || !Array.isArray(button.link)) return false;
                const card = get.autoViewAs({
                  name: button.link[2],
                  nature: button.link[3],
                  isCard: true
                }, "unsure");
                if (!lib.skill.xd_fuding.isImmediate(card)) return false;
                try {
                  return !!event.filterCard(card, player, event);
                } catch (e) {
                  return false;
                }
              },
              check(button) {
                const player = get.player();
                const card = {
                  name: button.link[2],
                  nature: button.link[3],
                  isCard: true
                };
                return player.getUseValue(card);
              },
              backup(links) {
                const link = links[0] || [];
                const viewAs = {
                  name: link[2] || "sha",
                  nature: link[3],
                  isCard: true
                };
                return {
                  position: "he",
                  selectCard: [1, Infinity],
                  complexCard: true,
                  popname: true,
                  log: false,
                  sourceSkill: "xd_fuding",
                  viewAs,
                  filterCard(card, player) {
                    const required = lib.skill.xd_fuding.getRequired(player);
                    if (required.includes("legal") && ["shan", "wuxie"].includes(viewAs.name)) {
                      // 若本次还欠3.，则转化【闪】/【无懈】时每张底牌本身也必须能以同一牌目标使用；
                      // 对核心牌池而言即要求底牌本身也是同名牌。
                      return lib.skill.xd_fuding.getBottomName(card) === viewAs.name;
                    }
                    return true;
                  },
                  check(card) {
                    const player = get.player();
                    // AI 默认少投入底牌；玩家仍可按规则选择任意张。
                    if (ui.selected.cards.length >= 1) return 0;
                    return 7 - get.value(card, player);
                  }
                };
              },
              prompt(links) {
                const link = links[0] || [];
                const card = {
                  name: link[2] || "sha",
                  nature: link[3],
                  isCard: true
                };
                return "发动【扶鼎】：选择至少一张底牌，将之当" + get.translation(card) + "使用";
              }
            },
            hiddenCard(player, name) {
              const event = _status.event;
              if (!event || event.name !== "chooseToUse" || !player.countCards("he")) return false;
              return lib.skill.xd_fuding.getLegalVCards(event, player).some(info => info[2] === name);
            },
            mod: {
              cardEnabled(card, player) {
                return lib.skill.xd_fuding.candidateEnabled(card, player);
              },
              cardSavable(card, player) {
                return lib.skill.xd_fuding.candidateEnabled(card, player);
              },
              targetEnabled(card, player, target) {
                if (_status._xd_fuding_baseTargetCheck) return;
                const required = lib.skill.xd_fuding.getRequired(player);
                if (!required.length) return;
                if (!lib.skill.xd_fuding.targetPasses(card, player, target, required)) return false;
              }
            },
            group: ["xd_fuding_gate", "xd_fuding_consume"],
            subSkill: {
              backup: {},
              gate: {
                ...silentRule,
                firstDo: true,
                trigger: {
                  player: "useCardBefore"
                },
                filter(event, player) {
                  const skill = lib.skill.xd_fuding;
                  return skill.getRequired(player).length > 0 || skill.isFudingUse(event);
                },
                content(event, trigger, player) {
                  const skill = lib.skill.xd_fuding;
                  const snapshot = skill.evaluate(trigger, player);
                  trigger._xd_fuding_snapshot = snapshot;
                  const required = skill.getRequired(player).slice();
                  if (required.length && !required.every(item => snapshot.satisfied[item])) {
                    trigger.cancel();
                    game.log(
                      player,
                      "因【扶鼎】上次留下的目标条件不能使用",
                      trigger.card,
                      "（尚须",
                      "#y" + required.map(item => skill.itemName(item)).join("、"),
                      "）"
                    );
                  }
                }
              },
              consume: {
                ...silentRule,
                firstDo: true,
                trigger: {
                  player: "useCard"
                },
                filter(event, player) {
                  const skill = lib.skill.xd_fuding;
                  return skill.getRequired(player).length > 0 || skill.isFudingUse(event);
                },
                content(event, trigger, player) {
                  const skill = lib.skill.xd_fuding;
                  const wasFuding = skill.isFudingUse(trigger);
                  // 只要这张牌已经合法进入 useCard，上一次【扶鼎】的“下次使用牌”就已完成。
                  if (skill.getRequired(player).length) player.storage.xd_fuding_required = [];
                  if (wasFuding) {
                    player.logSkill("xd_fuding");
                    const snapshot = trigger._xd_fuding_snapshot || skill.evaluate(trigger, player);
                    player.storage.xd_fuding_required = skill.allItems.filter(item => !snapshot.satisfied[item]);
                    if (player.storage.xd_fuding_required.length) {
                      game.log(
                        player,
                        "此次【扶鼎】尚未满足",
                        "#y" + player.storage.xd_fuding_required.map(item => skill.itemName(item)).join("、"),
                        "；其下次使用牌须满足这些目标条件"
                      );
                    } else {
                      game.log(player, "此次【扶鼎】已满足全部三项，下次使用牌不受其限制");
                    }
                  }
                  skill.syncState(player);
                }
              }
            },
            ai: {
              order: 8,
              respondShan: true,
              respondSha: true,
              save: true,
              result: {
                player: 1
              }
            }
          },
          xd_shown_cards_viewer: {
            ...silentRule,
            mark: true,
            marktext: "明",
            intro: {
              markcount(storage, player) {
                return lib.xd_utils.getShownHandCards(player).length;
              },
              mark(dialog, content, player) {
                const cards = lib.xd_utils.getShownHandCards(player);
                if (cards.length) {
                  dialog.addText(get.translation(player) + "当前的明置手牌");
                  dialog.addAuto(cards);
                } else {
                  return "当前没有明置手牌";
                }
              }
            },
            trigger: {
              player: "loseAfter",
              global: "loseAsyncAfter"
            },
            content(event, trigger, player) {
              lib.xd_utils.updateShownCards(player);
            }
          },
          // 桓温
          bolyuba: {
              init(player) {
                  // 不在 onremove 时清除：
                  // 若【欲罢】失去后又重新获得，过去的拒绝次数仍然保留。
                  if (typeof player.storage.bolyuba_refuse !== 'number') {
                      player.storage.bolyuba_refuse = 0;
                  }
              },

              // 用全局 damageEnd 统一监听“造成或受到伤害后”。
              // 同一个自伤事件只会触发一次，因此“造成且受到”不会重复计算。
              trigger: { global: 'damageEnd' },

              filter(event, player) {
                  return event.player === player || event.source === player;
              },

              // 必须自己询问是否发动：
              // 如果交给普通可选触发技处理，玩家点“不发动”以后 content 不会执行，
              // 我们也就无法记录“拒绝次数”。
              direct: true,

              async content(event, trigger, player) {
                  const num = player.storage.bolyuba_refuse || 0;

                  const canDiscard = player.hasCard(card => {
                      return lib.filter.cardDiscardable(card, player) &&
                          get.number(card) == num;
                  }, 'he');

                  const skills = player.getSkills(null, false, false).filter(skill => {
                      const info = get.info(skill);
                      return info && !info.charlotte;
                  });

                  const controls = [];
                  if (canDiscard) controls.push('弃牌');
                  if (skills.length) controls.push('失去技能');
                  controls.push('取消');

                  const result = await player.chooseControl(controls)
                      .set(
                          'prompt',
                          `###欲罢###弃置一张点数为${num}的牌或失去一个技能，然后将手牌摸至${num}张；取消则视为拒绝发动`
                      )
                      .set('num', num)
                      .set('canDiscard', canDiscard)
                      .set('skills', skills)
                      .set('ai', () => {
                          const player = get.event().player;
                          const num = get.event().num;
                          const skills = get.event().skills || [];

                          // 优先借机甩掉负面技能
                          if (skills.some(skill => {
                              const info = get.info(skill);
                              return info?.ai?.neg || info?.ai?.halfneg;
                          })) {
                              return '失去技能';
                          }

                          // 有实际摸牌收益时，优先支付牌的代价
                          if (
                              get.event().canDiscard &&
                              player.countCards('h') < num
                          ) {
                              return '弃牌';
                          }

                          return '取消';
                      })
                      .forResult();

                  // 没有支付任何代价 = 拒绝发动。
                  // 本次拒绝只影响下一次及以后，所以当前 X 仍然是旧值 num。
                  if (!result?.control || result.control == '取消') {
                      player.storage.bolyuba_refuse = num + 1;
                      return;
                  }

                  player.logSkill('bolyuba');

                  if (result.control == '弃牌') {
                      await player.chooseToDiscard(
                          'he',
                          true,
                          card => {
                              return lib.filter.cardDiscardable(card, player) &&
                                  get.number(card) == get.event().num;
                          },
                          `请弃置一张点数为${num}的牌`
                      ).set('num', num);
                  }
                  else {
                      const list = skills.map(skill => [
                          skill,
                          '<div class="popup text" style="width:calc(100% - 10px);display:inline-block">' +
                          '<div class="skill">' +
                          (
                              lib.skill[skill]?.nobracket
                                  ? get.translation(skill)
                                  : '【' + get.translation(skill) + '】'
                          ) +
                          '</div><div>' +
                          (lib.translate[skill + '_info'] || '') +
                          '</div></div>',
                      ]);

                      const lose = await player.chooseButton([
                          '###欲罢###选择失去一个技能',
                          [list, 'textbutton'],
                      ], true)
                          .set('displayIndex', false)
                          .set('ai', button => {
                              const skill = button.link;
                              const info = get.info(skill);

                              if (info?.ai?.neg || info?.ai?.halfneg) return 10;

                              // 行将生成的技能相对适合作为代价
                              if (skill.startsWith('bolhuanwen_')) return 5;

                              // 尽量别让 AI 主动把欲罢自己扔掉
                              if (skill == 'bolyuba') return -10;

                              return 1;
                          })
                          .forResult();

                      if (lose?.bool && lose.links?.length) {
                          await player.removeSkills(lose.links[0]);
                      }
                  }

                  // 先支付代价，再摸至 X 张。
                  await player.drawTo(num);
              },
          },
          bolxingjiang: {
              enable: 'phaseUse',
              usable: 1,

              filter(event, player) {
                  const cards = player.getCards('he', card => {
                      // get.type == trick 时为普通锦囊；
                      // 延时锦囊的类型不是 trick，因此不会被算作“即时牌”。
                      return ['basic', 'trick'].includes(get.type(card));
                  });

                  return cards.some(card => {
                      return cards.filter(i => i.name == card.name).length >= 2;
                  });
              },

              filterCard(card, player) {
                  if (!['basic', 'trick'].includes(get.type(card))) return false;

                  if (
                      ui.selected.cards.length &&
                      ui.selected.cards[0].name != card.name
                  ) {
                      return false;
                  }

                  // 至少要确实拥有两张同名即时牌
                  return player.getCards('he', i => {
                      return ['basic', 'trick'].includes(get.type(i)) &&
                          i.name == card.name;
                  }).length >= 2;
              },

              selectCard: [2, Infinity],
              position: 'he',
              complexCard: true,

              check(card) {
                  const player = get.event().player;

                  // 规则允许扔任意多张，但正常情况下没有理由多扔，
                  // AI 选够两张以后就停止。
                  if (ui.selected.cards.length >= 2) return 0;

                  const hasSkill = player.hasSkill(
                      `bolhuanwen_${card.name}`,
                      null,
                      null,
                      false
                  );

                  return (hasSkill ? 6 : 10) - get.value(card);
              },

              async content(event, trigger, player) {
                  const name = event.cards[0].name;
                  const skill = `bolhuanwen_${name}`;

                  // 同一牌名对应同一个动态技能；
                  // 已经创建过就直接复用，不重复注册。
                  if (!lib.skill[skill]) {
                      game.broadcastAll((skill, name) => {
                          const cardName = get.translation(name);

                          // 原生技能栏会直接把 lib.translate[skill] 作为按钮文字。
                          // 这里让按钮只显示牌名的前两字，保持原生技能按钮的紧凑尺寸；
                          // 完整的“行将•牌名”则交给 _ab，用于技能信息等原生展示。
                          lib.translate[skill] = cardName.slice(0, 2);
                          lib.translate[`${skill}_ab`] =
                              `行将•${cardName.slice(0, 2)}`;

                          lib.translate[`${skill}_info`] =
                              `每轮限一次，你可以视为使用一张【${cardName}】。`;

                          lib.skill[skill] = {
                              nobracket: true,

                              enable: 'chooseToUse',

                              // 真正的“每轮限一次”，不是旧版的 usable: 1。
                              round: 1,

                              viewAs: {
                                  name,
                                  isCard: true,
                              },

                              // 不消耗实体牌，纯粹视为使用。
                              filterCard: () => false,
                              selectCard: -1,

                              prompt: `视为使用【${cardName}】`,
                          };

                          game.finishSkill(skill);
                      }, skill, name);
                  }

                  player.popup(skill);
                  await player.addSkills(skill);
              },

              ai: {
                  order(item, player) {
                      let cards = player.getCards('he', card => {
                          return ['basic', 'trick'].includes(get.type(card)) &&
                              player.getUseValue(card) > 0;
                      });

                      cards = cards.filter(card => {
                          return cards.filter(i => i.name == card.name).length >= 2;
                      });

                      if (!cards.length) return 1;

                      cards.sort((a, b) => get.order(b) - get.order(a));
                      return get.order(cards[0]) + 0.001;
                  },

                  result: {
                      player: 1,
                  },
              },
          },
          xd_hujia: {
            locked: true,
            line2Active(player) {
              return !player.storage.xd_hujia_line2_deleted;
            },
            getRevealCandidates(player, materials) {
              materials = Array.isArray(materials) ? materials : [];
              return player.getCards("h", card => !materials.includes(card) && !lib.xd_utils.isShownHandCard(card, player));
            },
            candidateEnabled(card, player) {
              const skill = lib.skill.xd_hujia;
              if (!skill.line2Active(player)) {
                return;
              }
              const allDark = lib.xd_utils.getUnshownHandCards(player);
              if (!allDark.length) {
                return false;
              }
              const materials = lib.xd_utils.getMaterialCards(card);
              if (materials.length) {
                return skill.getRevealCandidates(player, materials).length ? undefined : false;
              }
            },
            async revealCard(player, card) {
              return (await lib.xd_utils.revealHandCards(player, [card], "visible_xd_hujia", "因【胡笳】明置")).length > 0;
            },
            // 第二行删除后同时解除 noSortCard 与明置支付；恒三张不受影响。
            ai: {
              noSortCard: true,
              skillTagFilter(player, tag) {
                if (tag === "noSortCard" && !lib.skill.xd_hujia.line2Active(player)) {
                  return false;
                }
              }
            },
            mod: {
              cardEnabled(card, player) {
                return lib.skill.xd_hujia.candidateEnabled(card, player);
              },
              cardSavable(card, player) {
                return lib.skill.xd_hujia.candidateEnabled(card, player);
              }
            },
            group: ["xd_hujia_balance", "xd_hujia_gate", "xd_hujia_protect", "xd_hujia_track", "xd_caiyan_sort"],
            subSkill: {
              // firstDo 在后续位置观察前恢复三张；phaseBefore 仅作开局兜底。
              balance: {
                ...silentRule,
                firstDo: true,
                trigger: {
                  player: ["gainAfter", "loseAfter", "enterGame"],
                  global: ["loseAsyncAfter", "phaseBefore"]
                },
                filter(event, player) {
                  if (event.name === "phase" && game.phaseNumber !== 0) {
                    return false;
                  }
                  return player.isIn() && player.countCards("h") !== 3;
                },
                async content(event, trigger, player) {
                  const num = player.countCards("h");
                  if (num < 3) {
                    await player.drawTo(3);
                    return;
                  }
                  if (num > 3) {
                    const discardNum = num - 3;
                    await player.chooseToDiscard({
                      position: "h",
                      selectCard: discardNum,
                      forced: true,
                      prompt: "胡笳：请弃置" + get.cnNumber(discardNum) + "张手牌，将手牌数调整为三张",
                      ai(card) {
                        return 8 - get.value(card);
                      }
                    }).forResult();
                  }
                }
              },
              // useCardBefore 用最终材料复核；选牌预览时材料未齐的虚拟牌不能提前判死。
              gate: {
                charlotte: true,
                forced: true,
                popup: false,
                firstDo: true,
                trigger: {
                  player: "useCardBefore"
                },
                filter(event, player) {
                  return lib.skill.xd_hujia.line2Active(player);
                },
                async content(event, trigger, player) {
                  const skill = lib.skill.xd_hujia;
                  const materials = lib.xd_utils.getMaterialCards(trigger.card, trigger);
                  const candidates = skill.getRevealCandidates(player, materials);
                  if (!candidates.length) {
                    trigger.cancel();
                    game.log(player, "因【胡笳】没有可明置的另一张手牌，不能使用", trigger.card);
                    return;
                  }
                  let chosen;
                  if (candidates.length === 1) {
                    chosen = candidates[0];
                  } else {
                    const result = await player.chooseCard({
                      prompt: "胡笳：明置一张不属于此次用牌材料的暗置手牌",
                      forced: true,
                      position: "h",
                      filterCard(card) {
                        return get.event().candidates.includes(card);
                      },
                      ai(card) {
                        return 8 - get.value(card);
                      }
                    }).set("candidates", candidates).forResult();
                    if (!result?.bool || !result.cards?.length) {
                      trigger.cancel();
                      return;
                    }
                    chosen = result.cards[0];
                  }
                  const success = await skill.revealCard(player, chosen);
                  if (!success) {
                    trigger.cancel();
                  }
                }
              },
              // 保留 chooseBool；保护只从待移除列表剔除胡笳，不取消其他技能的失去。
              protect: {
                charlotte: true,
                direct: true,
                firstDo: true,
                trigger: {
                  player: "changeSkillsBefore"
                },
                filter(event, player) {
                  return Array.isArray(event.removeSkill) && event.removeSkill.includes("xd_hujia");
                },
                async content(event, trigger, player) {
                  const result = await player.chooseBool("【胡笳】：是否防止【胡笳】失去？").set("ai", () => true).forResult();
                  if (!result.bool) {
                    return;
                  }
                  trigger.removeSkill.remove("xd_hujia");
                  player.logSkill("xd_hujia");
                  game.log(player, "防止了【胡笳】的失去");
                }
              },
              // 挂在胡笳上：时愿觉醒暂时失效时，仍需持续记录上次使用牌的角色。
              track: {
                ...silentRule,
                firstDo: true,
                trigger: {
                  global: "useCard1"
                },
                filter(event, player) {
                  return !!event.player;
                },
                content(event, trigger, player) {
                  player.storage.xd_caiyan_last_card_user = trigger.player;
                }
              }
            }
          },
          xd_liuhe: {
            ...caiyanRecord(),
            marktext: "六",
            filter(event, player) {
              return player.countCards("h") === 3 && player.storage.xd_liuhe_seen !== 63;
            },
            intro: {
              markcount(storage, player) {
                return lib.xd_utils.caiyanRecordCount(player, "xd_liuhe");
              },
              content(storage, player) {
                return lib.xd_utils.caiyanRecordText(player, "xd_liuhe");
              }
            }
          },
          xd_bahuang: {
            ...caiyanRecord(),
            marktext: "八",
            filter(event, player) {
              return player.countCards("h") === 3 && player.storage.xd_bahuang_seen !== 255;
            },
            intro: {
              markcount(storage, player) {
                return lib.xd_utils.caiyanRecordCount(player, "xd_bahuang");
              },
              content(storage, player) {
                return lib.xd_utils.caiyanRecordText(player, "xd_bahuang");
              }
            }
          },
          xd_shiyuan: {
            ...caiyanAwakening(),
            derivation: ["xd_liuhe", "xd_guiyan"],
            trigger: {
              player: "changeHp"
            },
            filter(event, player) {
              return typeof event.originalHp === "number" && event.originalHp <= 0 && player.hp > 0;
            }
          },
          xd_jieqing: {
            ...caiyanAwakening(),
            derivation: ["xd_bahuang"],
            trigger: {
              player: ["changeHp", "loseMaxHpAfter"]
            },
            filter(event, player) {
              if (typeof event.originalHp !== "number" || typeof event.originalMaxHp !== "number") {
                return false;
              }
              return event.originalHp < event.originalMaxHp && player.hp >= player.maxHp;
            }
          },
          xd_caiyan_sort: {
            enable: "phaseUse",
            filter(event, player) {
              if (player.countCards("h") < 2) {
                return false;
              }
              if (player.hasSkill("xd_hujia") && lib.skill.xd_hujia.line2Active(player)) {
                return false;
              }
              return player.hasSkill("xd_hujia") || player.hasSkill("xd_liuhe") || player.hasSkill("xd_bahuang") || player.hasSkill("xd_guiyan");
            },
            // v1.11.5.2 sortHandcardOL 反向落位，传 order.slice().reverse()。完全反转会命中本体 early return，三张以上先交换前两张再落位；不可删。
            async content(event, trigger, player) {
              const cards = player.getCards("h").slice();
              if (cards.length < 2) {
                return;
              }
              const result = await player.chooseToMove({
                prompt: "整理手牌：拖动牌以调整从左到右的顺序",
                list: [["手牌（从左到右）", cards]],
                processAI(list) {
                  return [list[0][1].slice()];
                }
              }).forResult();
              const order = result?.moved?.[0];
              if (!result?.bool || !Array.isArray(order) || order.length !== cards.length) {
                return;
              }
              const current = player.getCards("h");
              if (current.length !== cards.length || !cards.every(card => current.includes(card))) {
                return;
              }
              const currentOrder = player.getCards("h").slice();
              const engineOrder = order.slice().reverse();
              const hitsEarlyReturn = currentOrder.length === engineOrder.length && currentOrder.every((card, index) => engineOrder[index] === card);
              if (hitsEarlyReturn && currentOrder.length >= 3) {
                const intermediate = currentOrder.slice();
                [intermediate[0], intermediate[1]] = [intermediate[1], intermediate[0]];
                player.sortHandcardOL(intermediate.slice().reverse());
              }
              player.sortHandcardOL(engineOrder);
              lib.xd_utils.recordCaiyanHandState(player);
            },
            ai: {
              order: 0.01,
              result: {
                player: 1
              }
            }
          },
          // 永久改写属于玩家的阶段槽位，失去归雁后也继续生效。
          xd_guiyan_permanent_rule: {
            ...silentRule,
            superCharlotte: true,
            fixed: true,
            firstDo: true,
            trigger: {
              player: "phaseBegin"
            },
            filter(event, player) {
              return Array.isArray(event.phaseList) && Array.isArray(player.storage.xd_guiyan_permanent) && player.storage.xd_guiyan_permanent.length > 0;
            },
            content(event, trigger, player) {
              for (const index of player.storage.xd_guiyan_permanent) {
                if (Number.isInteger(index) && index >= 0 && index < trigger.phaseList.length) {
                  trigger.phaseList[index] = "phaseUse|xd_guiyan";
                }
              }
            }
          },
          xd_guiyan: {
            locked: true,
            mark: true,
            marktext: "雁",
            init(player) {
              player.storage.xd_guiyan_progress = 0;
              player.storage.xd_guiyan_permanent ??= [];
              if (player.storage.xd_guiyan_permanent.length && !player.hasSkill("xd_guiyan_permanent_rule")) {
                player.addSkill("xd_guiyan_permanent_rule");
              }
            },
            intro: {
              markcount(storage, player) {
                return Math.min(3, player.storage.xd_guiyan_progress ?? 0);
              },
              content(storage, player) {
                const progress = Math.min(3, player.storage.xd_guiyan_progress ?? 0);
                const lines = ["本回合归雁次序：" + progress + "/3"];
                const permanent = player.storage.xd_guiyan_permanent ?? [];
                if (permanent.length) {
                  const names = permanent.slice().sort((a, b) => a - b).map(index => lib.skill.xd_guiyan.phaseSlotName(index));
                  lines.push("已永久改为出牌阶段：" + names.join("、"));
                }
                return lines.join("<br>");
              }
            },
            group: ["xd_guiyan_snapshot", "xd_guiyan_confirm", "xd_guiyan_finish", "xd_guiyan_turn", "xd_caiyan_sort"],
            getPhaseContext(event, player) {
              let current = event;
              let stage = null;
              let phase = null;
              for (let i = 0; i < 40 && current; i++) {
                if (!stage && current.player === player && typeof current.phaseIndex === "number") {
                  stage = current;
                }
                if (current.player === player && Array.isArray(current.phaseList)) {
                  phase = current;
                  break;
                }
                let next = null;
                if (typeof current.getParent === "function") {
                  next = current.getParent();
                } else {
                  next = current.parent;
                }
                if (!next || next === current) {
                  break;
                }
                current = next;
              }
              if (!stage || !phase) {
                return null;
              }
              return {
                stage,
                phase,
                index: stage.phaseIndex
              };
            },
            getPhaseName(entry) {
              if (typeof entry !== "string") {
                return "";
              }
              let name = entry.split("|")[0].split("-")[0];
              if (name.startsWith("skip")) {
                name = "phase" + name.slice(4);
              }
              return name;
            },
            phaseSlotName(index) {
              return ["准备阶段", "判定阶段", "摸牌阶段", "出牌阶段", "弃牌阶段", "结束阶段"][index] ?? "第" + get.cnNumber(index + 1) + "个阶段";
            },
            phaseNameText(entry, index) {
              const names = {
                phaseZhunbei: "准备阶段",
                phaseJudge: "判定阶段",
                phaseDraw: "摸牌阶段",
                phaseUse: "出牌阶段",
                phaseDiscard: "弃牌阶段",
                phaseJieshu: "结束阶段"
              };
              const name = lib.skill.xd_guiyan.getPhaseName(entry);
              return names[name] ?? lib.skill.xd_guiyan.phaseSlotName(index);
            },
            subSkill: {
              turn: {
                ...silentRule,
                firstDo: true,
                trigger: {
                  player: "phaseBegin"
                },
                content(event, trigger, player) {
                  player.storage.xd_guiyan_progress = 0;
                  player.markSkill("xd_guiyan");
                }
              },
              // 每次 useCardBefore 读取当前顺序；纯虚拟牌不推进也不打断，错位的当前左1可重新起步。
              snapshot: {
                ...silentRule,
                firstDo: true,
                trigger: {
                  player: "useCardBefore"
                },
                filter(event, player) {
                  return _status.currentPhase === player;
                },
                content(event, trigger, player) {
                  const progress = player.storage.xd_guiyan_progress ?? 0;
                  if (progress >= 3) {
                    return;
                  }
                  const hand = player.getCards("h").slice();
                  const materials = lib.xd_utils.getMaterialCards(trigger.card, trigger);
                  const handMaterials = materials.filter(card => hand.includes(card));
                  if (!handMaterials.length) {
                    return;
                  }
                  const expected = hand[progress];
                  let nextProgress;
                  if (expected && handMaterials.includes(expected)) {
                    nextProgress = progress + 1;
                  } else if (hand[0] && handMaterials.includes(hand[0])) {
                    nextProgress = 1;
                  } else {
                    nextProgress = 0;
                  }
                  trigger._xd_guiyan_next_progress = nextProgress;
                }
              },
              // useCard1 才提交进度，避免支付胡笳失败/取消用牌也推进。
              confirm: {
                ...silentRule,
                trigger: {
                  player: "useCard1"
                },
                filter(event, player) {
                  return typeof event._xd_guiyan_next_progress === "number";
                },
                content(event, trigger, player) {
                  const nextProgress = trigger._xd_guiyan_next_progress;
                  player.storage.xd_guiyan_progress = nextProgress;
                  if (nextProgress >= 3) {
                    trigger._xd_guiyan_completed = true;
                  }
                  player.markSkill("xd_guiyan");
                }
              },
              // 第三张完整结算后改阶段；上一阶段按 slot identity 判定，不能用临时 phaseUse 排除。
              finish: {
                charlotte: true,
                forced: true,
                popup: false,
                trigger: {
                  player: "useCardAfter"
                },
                filter(event, player) {
                  return !!event._xd_guiyan_completed;
                },
                async content(event, trigger, player) {
                  const skill = lib.skill.xd_guiyan;
                  player.storage.xd_guiyan_progress = 0;
                  player.markSkill("xd_guiyan");
                  const context = skill.getPhaseContext(trigger, player);
                  if (!context) {
                    game.log(player, "完成了【归雁】，但当前没有可修改的回合阶段");
                    return;
                  }
                  const phaseList = context.phase.phaseList;
                  const currentIndex = context.index;
                  const permanent = player.storage.xd_guiyan_permanent ??= [];
                  const options = [];
                  const previousIndex = currentIndex - 1;
                  if (previousIndex >= 0 && previousIndex < phaseList.length && previousIndex !== 3 && !permanent.includes(previousIndex)) {
                    options.push({
                      type: "previous",
                      index: previousIndex,
                      control: "将上一阶段永久改为出牌阶段（" + skill.phaseSlotName(previousIndex) + "）"
                    });
                  }
                  const nextIndex = currentIndex + 1;
                  if (nextIndex >= 0 && nextIndex < phaseList.length && skill.getPhaseName(phaseList[nextIndex]) !== "phaseUse") {
                    options.push({
                      type: "next",
                      index: nextIndex,
                      control: "将本回合下一阶段改为出牌阶段（" + skill.phaseNameText(phaseList[nextIndex], nextIndex) + "）"
                    });
                  }
                  if (!options.length) {
                    game.log(player, "完成了【归雁】，但没有可改为出牌阶段的相邻阶段");
                    return;
                  }
                  let chosen = options[0];
                  if (options.length > 1) {
                    const controls = options.map(item => item.control);
                    const result = await player.chooseControl(controls).set("prompt", "归雁：选择要改为出牌阶段的阶段").set("ai", () => {
                      const index = options.findIndex(item => item.type === "previous");
                      return index >= 0 ? index : 0;
                    }).forResult();
                    const index = controls.indexOf(result.control);
                    if (index >= 0) {
                      chosen = options[index];
                    }
                  }
                  if (chosen.type === "previous") {
                    permanent.push(chosen.index);
                    permanent.sort((a, b) => a - b);
                    if (typeof player.syncStorage === "function") {
                      player.syncStorage("xd_guiyan_permanent");
                    }
                    if (!player.hasSkill("xd_guiyan_permanent_rule")) {
                      player.addSkill("xd_guiyan_permanent_rule");
                    }
                    game.log(player, "将今后回合的", "#g" + skill.phaseSlotName(chosen.index), "永久改为了", "#y出牌阶段");
                  } else {
                    const oldName = skill.phaseNameText(phaseList[chosen.index], chosen.index);
                    context.phase.phaseList[chosen.index] = "phaseUse|xd_guiyan";
                    game.log(player, "将本回合的", "#g" + oldName, "改为了", "#y出牌阶段");
                  }
                }
              }
            }
          },
          xd_congzu: {
            ...wuqiSwitch(),
            wuqiTypes: ["basic"],
            filter(event, player) {
              return lib.xd_utils.wuqiYangEnabled(event, player, "xd_congzu");
            },
            mod: {
              cardUsable(card, player, num) {
                if (player.storage.xd_congzu && get.name(card, player) === "sha") {
                  return num + lib.xd_utils.getWuqiX(player);
                }
              }
            }
          },
          xd_yibian: {
            ...wuqiSwitch(),
            wuqiTypes: ["trick", "delay"],
            filter(event, player) {
              return lib.xd_utils.wuqiYangEnabled(event, player, "xd_yibian");
            },
            group: ["xd_yibian_draw"],
            subSkill: {
              draw: {
                ...silentSkill,
                trigger: {
                  player: "phaseDrawBegin2"
                },
                filter(event, player) {
                  return !!player.storage.xd_yibian && !event.numFixed && lib.xd_utils.getWuqiX(player) > 0;
                },
                content(event, trigger, player) {
                  trigger.num += lib.xd_utils.getWuqiX(player);
                }
              }
            }
          },
          xd_bailian: {
            locked: true,
            forced: true,
            mark: true,
            marktext: "炼",
            init(player) {
              lib.xd_utils.initWuqi(player);
            },
            onremove(player, skill) {
              delete player.storage.xd_bailian_position;
              delete player.storage.xd_bailian_count;
              player.removeTip(skill);
            },
            intro: {
              nocount: true,
              content(storage, player) {
                const position = lib.xd_utils.getWuqiBailianPosition(player);
                return "百炼 当前位置：" + lib.xd_utils.getWuqiPositionLabel(position) + "<br>X：" + lib.xd_utils.getWuqiX(player) + "<br>百炼是否依赖其他触发条件：" + (lib.xd_utils.isWuqiBailianActive(player) ? "否" : "是");
              }
            },
            group: ["xd_bailian_selftarget", "xd_bailian_special"],
            subSkill: {
              selftarget: {
                trigger: {
                  target: "useCardToTarget"
                },
                forced: true,
                popup: false,
                filter(event, player) {
                  // target 入口本身保证本次指定到了自己；混合目标仍沿用附件行为，不追加全体目标限制。
                  return event.player === player && lib.xd_utils.isWuqiBailianActive(player) && !lib.xd_utils.wuqiActionHandled(event, player, "bailian");
                },
                async content(event, trigger, player) {
                  await lib.xd_utils.resolveWuqiBailian(player, trigger);
                }
              },
              special: {
                trigger: {
                  player: ["useCardAfter", "respondEnd"]
                },
                forced: true,
                popup: false,
                filter(event, player) {
                  if (!event.card) {
                    return false;
                  }
                  const name = get.name(event.card, player);
                  if (name !== "shan" && name !== "wuxie") {
                    return false;
                  }
                  return lib.xd_utils.isWuqiBailianActive(player) && !lib.xd_utils.wuqiActionHandled(event, player, "bailian");
                },
                async content(event, trigger, player) {
                  await lib.xd_utils.resolveWuqiBailian(player, trigger);
                }
              }
            }
          },
          xd_youren: {
            audio: 2,
            locked: true,
            mark: true,
            marktext: "平",
            init(player) {
              lib.skill.xd_youren.updateMark(player);
            },
            onremove(player, skill) {
              delete player.storage.xd_youren;
              player.removeTip(skill);
            },
            // B/D 为整局计数；不在阶段或回合开始清零，B===D 由 mod 实时检查。
            getCounts(player) {
              return player.storage.xd_youren ??= [0, 0];
            },
            isBalanced(player) {
              const counts = lib.skill.xd_youren.getCounts(player);
              return counts[0] === counts[1];
            },
            // 优先取实际摸到的 cards；保留旧事件结构的 result 数组及 num 最后回退。
            getActualDrawCount(event) {
              if (!event) {
                return 0;
              }
              try {
                if (event.result && Array.isArray(event.result.cards)) {
                  return event.result.cards.length;
                }
              } catch (e) {}
              if (Array.isArray(event.cards)) {
                return event.cards.length;
              }
              try {
                if (event.result && Array.isArray(event.result)) {
                  return event.result.length;
                }
              } catch (e) {}
              if (typeof event.num === "number") {
                return event.num;
              }
              return 0;
            },
            updateMark(player) {
              const counts = lib.skill.xd_youren.getCounts(player);
              const active = counts[0] === counts[1];
              lib.xd_utils.updateTip(player, "xd_youren", "游刃 " + counts[0] + "/" + counts[1] + (active ? "｜平" : "｜仄"));
            },
            intro: {
              nocount: true,
              content(storage, player) {
                const counts = lib.skill.xd_youren.getCounts(player);
                const active = counts[0] === counts[1];
                let str = "使用基本牌：" + counts[0] + "<br>恰摸两张牌：" + counts[1] + "<br>当前平衡：" + (active ? "是" : "否");
                if (active) {
                  str += "<br>【游刃】生效：" + "使用【杀】无次数限制；" + "锦囊牌均视为【无中生有】";
                } else {
                  str += "<br>【游刃】当前未生效。";
                }
                return str;
              }
            },
            mod: {
              cardUsable(card, player, num) {
                if (lib.skill.xd_youren.isBalanced(player) && get.name(card, player) === "sha") {
                  return Infinity;
                }
              },
              cardname(card, player) {
                if (!lib.skill.xd_youren.isBalanced(player)) {
                  return;
                }
                const type = get.type(card, null, false);
                if (type === "trick" || type === "delay") {
                  return "wuzhong";
                }
              }
            },
            group: ["xd_youren_basic_count", "xd_youren_draw_count"],
            subSkill: {
              basic_count: {
                ...silentSkill,
                trigger: {
                  player: "useCardAfter"
                },
                filter(event, player) {
                  return !!event.card && get.type(event.card) === "basic";
                },
                content(event, trigger, player) {
                  lib.skill.xd_youren.count(player, 0);
                }
              },
              draw_count: {
                ...silentSkill,
                trigger: {
                  player: "drawAfter"
                },
                filter(event, player) {
                  return lib.skill.xd_youren.getActualDrawCount(event) === 2;
                },
                content(event, trigger, player) {
                  lib.skill.xd_youren.count(player, 1);
                }
              }
            },
            count(player, index) {
              lib.skill.xd_youren.getCounts(player)[index]++;
              player.syncStorage("xd_youren");
              lib.skill.xd_youren.updateMark(player);
            }
          },
          xd_jiedu: {
            audio: 2,
            trigger: {
              target: "useCardToTarget"
            },
            direct: true,
            filter(event, player) {
              return !!event.card && !!event.player;
            },
            async chooseUnshownCards(target) {
              const cards = lib.xd_utils.getUnshownHandCards(target);
              if (!cards.length) {
                return [];
              }
              const result = await target.chooseCard({
                prompt: "【解渡】：选择任意张未明置手牌。" + "双方选择确定后同时明置（可选择0张）",
                position: "h",
                selectCard: [0, Infinity],
                forced: true,
                filterCard(card, current) {
                  return !lib.xd_utils.isShownHandCard(card, current);
                },
                ai(card) {
                  return 1 / Math.max(1, get.value(card));
                }
              }).forResult();
              return Array.isArray(result.cards) ? result.cards.slice() : [];
            },
            async revealAndMark(target, cards) {
              return lib.xd_utils.revealHandCards(target, cards, "visible_xd_jiedu", "因【解渡】明置");
            },
            getRealSuits(cards, owner) {
              return (cards ?? []).map(card => get.suit(card, owner)).filter(suit => ["spade", "heart", "club", "diamond"].includes(suit));
            },
            matches(chenCards, sourceCards, player, source) {
              const a = lib.skill.xd_jiedu.getRealSuits(chenCards, player);
              if (source === player) return new Set(a).size < a.length;
              const b = lib.skill.xd_jiedu.getRealSuits(sourceCards, source);
              return a.some(suit => b.includes(suit));
            },
            // 不调用 canUse/距离检查。保留装备、判定区和 targetEnabled2 的原引擎兜底。
            canTransferTarget(card, source, target, player) {
              if (!card || !source || !target || target === player || typeof target.isIn === "function" && !target.isIn()) {
                return false;
              }
              const name = get.name(card, source) || card.name;
              const type = get.type(card, null, false);
              if (name === "sha" && target === source) {
                return false;
              }
              if (name === "tao") {
                return typeof target.isDamaged === "function" && target.isDamaged();
              }
              if (name === "jiu" || name === "wuzhong") {
                return true;
              }
              if (type === "equip") {
                if (typeof target.canEquip === "function") {
                  try {
                    return !!target.canEquip(card, true);
                  } catch (e) {
                    try {
                      return !!target.canEquip(card);
                    } catch (e2) {}
                  }
                }
                const subtype = get.subtype(card, false);
                if (subtype && typeof target.hasEnabledSlot === "function") {
                  try {
                    return !!target.hasEnabledSlot(subtype);
                  } catch (e) {}
                }
                return true;
              }
              if (type === "delay") {
                if (typeof target.canAddJudge === "function") {
                  try {
                    return !!target.canAddJudge(card, source);
                  } catch (e) {
                    try {
                      return !!target.canAddJudge(card);
                    } catch (e2) {}
                  }
                }
                try {
                  if (typeof target.getVCards === "function") {
                    if (target.getVCards("j").some(current => get.name(current) === name)) {
                      return false;
                    }
                  } else if (target.getCards("j").some(current => get.name(current) === name)) {
                    return false;
                  }
                } catch (e) {}
                return true;
              }
              if (lib.filter && typeof lib.filter.targetEnabled2 === "function") {
                try {
                  return !!lib.filter.targetEnabled2(card, source, target);
                } catch (e) {}
              }
              try {
                const info = get.info(card, false);
                if (info && typeof info.filterTarget === "function") {
                  return !!info.filterTarget(card, source, target);
                }
              } catch (e) {}
              return false;
            },
            async recastAllShown(player) {
              const cards = lib.xd_utils.getShownHandCards(player);
              if (!cards.length) {
                return;
              }
              await player.recast(cards);
            },
            async content(event, trigger, player) {
              const source = trigger.player;
              if (!source) {
                return;
              }
              const useEvent = trigger.getParent();
              const originalTargets = useEvent && Array.isArray(useEvent.targets) ? useEvent.targets.slice() : Array.isArray(trigger.targets) ? trigger.targets.slice() : [];
              const unique = originalTargets.length === 1 && originalTargets.includes(player);
              const ask = await player.chooseBool("是否发动【解渡】？").set("ai", () => 1).forResult();
              if (!ask.bool) {
                return;
              }
              if (source === player) {
                player.logSkill("xd_jiedu");
              } else {
                player.logSkill("xd_jiedu", source);
              }
              // 双方先锁定选择，再公开；自己的牌只选择一次。只比较此次新明置结果。
              let chenCards = await lib.skill.xd_jiedu.chooseUnshownCards(player);
              let sourceCards = source === player ? [] : await lib.skill.xd_jiedu.chooseUnshownCards(source);
              chenCards = await lib.skill.xd_jiedu.revealAndMark(player, chenCards);
              if (source !== player) sourceCards = await lib.skill.xd_jiedu.revealAndMark(source, sourceCards);
              if (!lib.skill.xd_jiedu.matches(chenCards, sourceCards, player, source)) {
                return;
              }
              if (!unique) {
                await lib.skill.xd_jiedu.recastAllShown(player);
                return;
              }
              const validTargets = game.filterPlayer(target => lib.skill.xd_jiedu.canTransferTarget(trigger.card, source, target, player));
              if (validTargets.length) {
                const result = await player.chooseTarget({
                  prompt: "【解渡】：选择一名角色转移" + get.translation(trigger.card) + "的目标；取消则重铸所有明置牌",
                  filterTarget(card, current, target) {
                    return lib.skill.xd_jiedu.canTransferTarget(trigger.card, source, target, player);
                  },
                  ai(target) {
                    return get.effect(target, trigger.card, source, player);
                  }
                }).forResult();
                if (result.bool && Array.isArray(result.targets) && result.targets.length) {
                  const target = result.targets[0];
                  if (useEvent && useEvent.triggeredTargets2 && typeof useEvent.triggeredTargets2.remove === "function") {
                    useEvent.triggeredTargets2.remove(player);
                  }
                  if (useEvent && Array.isArray(useEvent.targets)) {
                    if (typeof useEvent.targets.remove === "function") {
                      useEvent.targets.remove(player);
                    } else {
                      const index = useEvent.targets.indexOf(player);
                      if (index >= 0) {
                        useEvent.targets.splice(index, 1);
                      }
                    }
                    if (!useEvent.targets.includes(target)) {
                      useEvent.targets.push(target);
                    }
                  }
                  game.log(player, "将", trigger.card, "的目标转移给了", target);
                  return;
                }
              }
              await lib.skill.xd_jiedu.recastAllShown(player);
            }
          },
          // 清风提供的稳定实现；动态描述 xd_sijiao 保留原文本逻辑。
          xd_sijiao: {
            audio: 2,
            forced: true,
            init(player, skill) {
              if (!player.storage.xd_sijiao) player.storage.xd_sijiao = [0, 1, 2];
              player.addTip(skill, get.translation(skill) + ' ' + player.storage.xd_sijiao.slice().join(""));
            },
            onremove(player, skill) {
              delete player.storage.xd_sijiao;
              player.removeTip(skill);
            },
            trigger: {
              player: 'useCard'
            },
            mark: true,
            marktext: "明",
            intro: {
              markcount(storage, player) {
                return player.countCards("h", card => card.hasGaintag("xd_sijiao_tag"));
              },
              mark(dialog, content, player) {
                var cards = player.getCards("h", card => card.hasGaintag("xd_sijiao_tag"));
                if (cards.length) {
                  dialog.addAuto(cards);
                } else {
                  return "无明置牌";
                }
              }
            },
            async content(event, trigger, player) {
              var s = player.storage.xd_sijiao;
              if (s[0] > 0 && player.countCards("h", card => get.type(card) == 'basic' && card.hasGaintag("xd_sijiao_tag") && player.canRecast(card)) >= s[0]) {
                var {
                  result
                } = await player.chooseCard(true, 'h', '重铸' + s[0] + '张明置基本牌', s[0], card => get.type(card) == 'basic' && card.hasGaintag("xd_sijiao_tag") && player.canRecast(card)).set('ai', card => -get.value(card));
                if (result.bool) {
                  await player.recast(result.cards);
                }
              } else if (s[1] > 0 && player.countCards("h", card => !card.hasGaintag("xd_sijiao_tag")) >= s[1]) {
                var {
                  result
                } = await player.chooseCard(true, 'h', '明置' + s[1] + '张牌', s[1], card => !card.hasGaintag("xd_sijiao_tag")).set('ai', card => get.type(card) == 'basic');
                if (result.bool) {
                  var cards = result.cards;
                  await player.addGaintag(cards, "xd_sijiao_tag");
                  player.markSkill(event.name);
                }
              } else if (s[2] > 0 && player.countCards('h') < s[2]) {
                await player.drawTo(s[2]);
              } else {
                for (var i = 0; i < 3; i++) {
                  s[i]++;
                }
                player.addTip(event.name, get.translation(event.name) + ' ' + player.storage.xd_sijiao.slice().join(""));
              }
            },
            subSkill: {
              tag: {}
            }
          },
          xd_juemo: {
            audio: 2,
            mark: true,
            marktext: "漠",
            init(player) {
              lib.skill.xd_juemo.updateMark(player);
            },
            onremove(player, skill) {
              delete player.storage.xd_juemo_items;
              delete player.storage.xd_juemo_required;
              player.removeSkill("xd_juemo_lock");
              player.removeTip(skill);
            },
            intro: {
              content(storage, player) {
                const skill = lib.skill.xd_juemo;
                const items = skill.getItems(player);
                const required = skill.getRequired(player);
                const shown = player.getCards("h", card => lib.xd_utils.isShownHandCard(card, player));
                let str = "当前项目：" + items.map(item => skill.itemName(item)).join("、");
                if (required.length) {
                  str += "<br>下次使用牌须同时满足：" + required.map(item => skill.itemName(item)).join("、");
                } else {
                  str += "<br>当前无用牌限制";
                }
                if (shown.length) {
                  str += "<br>当前明置手牌：" + get.translation(shown);
                } else {
                  str += "<br>当前无明置手牌";
                }
                return str;
              }
            },
            itemName(item) {
              return lib.xd_utils.juemoNames[item] || item;
            },
            getItems(player) {
              return player.storage.xd_juemo_items ??= ["basic", "black", "damage"];
            },
            getRequired(player) {
              return player.storage.xd_juemo_required ??= [];
            },
            syncState(player) {
              player.syncStorage("xd_juemo_items");
              player.syncStorage("xd_juemo_required");
              lib.skill.xd_juemo.updateMark(player);
            },
            updateMark(player) {
              const skill = lib.skill.xd_juemo;
              const names = {
                basic: "基",
                black: "黑",
                damage: "伤",
                shown: "明"
              };
              const items = skill.getItems(player);
              const required = skill.getRequired(player);
              let text = "绝漠 " + items.map(item => names[item]).join("/");
              if (required.length) {
                text += "｜须 " + required.map(item => names[item]).join("+");
              }
              lib.xd_utils.updateTip(player, "xd_juemo", text);
            },
            getTraits(card, player, event) {
              if (!card) return [];
              const traits = [];
              if (get.type(card) === "basic") traits.push("basic");
              if (get.color(card, player) === "black") traits.push("black");
              if (get.is.damageCard(card)) traits.push("damage");
              // B/K/D 看最终牌；M 要求至少一张实体材料，且全部材料在用牌前是明置手牌。
              const materials = lib.xd_utils.getMaterialCards(card, event);
              if (materials.length && materials.every(current => lib.xd_utils.isShownHandCard(current, player))) traits.push("shown");
              return traits;
            },
            meetsRequired(traits, required) {
              return required.every(item => traits.includes(item));
            },
            candidateEnabled(card, player) {
              const skill = lib.skill.xd_juemo;
              const required = skill.getRequired(player);
              if (!required.length) {
                return;
              }
              if (required.includes("basic") && get.type(card) !== "basic") {
                return false;
              }
              if (required.includes("damage") && !get.is.damageCard(card)) {
                return false;
              }
              const materials = lib.xd_utils.getMaterialCards(card);
              const itemtype = get.itemtype(card);
              if (required.includes("black")) {
                const color = get.color(card, player);
                if (color === "red") {
                  return false;
                }
                if (color !== "black" && (itemtype === "card" || materials.length)) {
                  return false;
                }
              }
              if (required.includes("shown")) {
                if (materials.length && !materials.every(current => lib.xd_utils.isShownHandCard(current, player))) {
                  return false;
                }
                if (itemtype === "card" && !lib.xd_utils.isShownHandCard(card, player)) {
                  return false;
                }
              }
            },
            group: ["xd_juemo_gate", "xd_juemo_consume"],
            trigger: {
              player: "useCardAfter"
            },
            filter(event, player) {
              const skill = lib.skill.xd_juemo;
              const traits = skill.getUseTraits(event, player);
              return skill.getItems(player).some(item => traits.includes(item));
            },
            async cost(event, trigger, player) {
              const skill = lib.skill.xd_juemo;
              const traits = skill.getUseTraits(trigger, player);
              const hit = skill.getItems(player).filter(item => traits.includes(item)).map(item => skill.itemName(item));
              event.result = await player.chooseBool("是否发动【绝漠】？" + (hit.length ? "（此牌满足：" + hit.join("、") + "）" : "")).set("ai", () => true).forResult();
            },
            // oldItems 与用牌前 traits 先取快照。R 只从 oldItems 计算，后续替换 M 不能回头改变 R。
            async content(event, trigger, player) {
              const skill = lib.skill.xd_juemo;
              const oldItems = skill.getItems(player).slice();
              const traits = skill.getUseTraits(trigger, player).slice();
              const drawResult = await player.draw(1).forResult();
              const cards = Array.isArray(drawResult.cards) ? drawResult.cards.filter(card => player.getCards("h").includes(card)) : [];
              if (cards.length) {
                await player.showCards(cards, get.translation(player) + "发动【绝漠】明置的牌");
                await player.addGaintag(cards, "xd_juemo_tag");
                player.markSkill("xd_juemo");
              }
              const remaining = oldItems.filter(item => !traits.includes(item));
              if (remaining.length === 0) {
                const replaceable = oldItems.filter(item => item !== "shown");
                if (replaceable.length) {
                  let chosen;
                  if (replaceable.length === 1) {
                    chosen = replaceable[0];
                  } else {
                    const controls = replaceable.map(item => skill.itemName(item));
                    const result = await player.chooseControl(controls).set("prompt", "绝漠：选择一项改为“明置牌”").set("ai", () => 0).forResult();
                    const index = controls.indexOf(result.control);
                    chosen = replaceable[index >= 0 ? index : 0];
                  }
                  const newItems = Array.from(new Set(oldItems.map(item => item === chosen ? "shown" : item)));
                  player.storage.xd_juemo_items = newItems;
                  game.log(player, "将【绝漠】的", "#y" + skill.itemName(chosen), "改为了", "#g明置牌");
                }
              }
              player.storage.xd_juemo_required = remaining;
              if (player.storage.xd_juemo_required.length) {
                player.addSkill("xd_juemo_lock");
              } else {
                player.removeSkill("xd_juemo_lock");
              }
              skill.syncState(player);
            },
            subSkill: {
              // 只有 required 非空才挂用牌锁，避免无约束时介入 chooseToUse。
              lock: {
                charlotte: true,
                popup: false,
                mod: {
                  cardEnabled(card, player) {
                    return lib.skill.xd_juemo.candidateEnabled(card, player);
                  },
                  cardSavable(card, player) {
                    return lib.skill.xd_juemo.candidateEnabled(card, player);
                  }
                }
              },
              // 材料离开手牌前保存 B/K/D/M；最终复核失败则取消，不能消耗旧限制。
              gate: {
                ...silentRule,
                firstDo: true,
                trigger: {
                  player: "useCardBefore"
                },
                content(event, trigger, player) {
                  const skill = lib.skill.xd_juemo;
                  const traits = skill.getTraits(trigger.card, player, trigger);
                  trigger._xd_juemo_traits = traits.slice();
                  const required = skill.getRequired(player);
                  if (required.length && !skill.meetsRequired(traits, required)) {
                    trigger.cancel();
                    game.log(player, "因【绝漠】不能使用", trigger.card, "（须同时满足", "#y" + required.map(item => skill.itemName(item)).join("、"), "）");
                  }
                }
              },
              // 合法牌真正进入 useCard 后消耗旧限制；结算后仍可再次发动绝漠。
              consume: {
                ...silentRule,
                firstDo: true,
                trigger: {
                  player: "useCard"
                },
                filter(event, player) {
                  return lib.skill.xd_juemo.getRequired(player).length > 0;
                },
                content(event, trigger, player) {
                  player.storage.xd_juemo_required = [];
                  player.removeSkill("xd_juemo_lock");
                  lib.skill.xd_juemo.syncState(player);
                }
              }
            },
            getUseTraits(event, player) {
              return Array.isArray(event._xd_juemo_traits) ? event._xd_juemo_traits : lib.skill.xd_juemo.getTraits(event.card, player, event);
            }
          },
          // 吕雉：六个固定牌名始终分为两个非空集合；左右无额外语义，因此以“含【杀】的一侧”为规范侧保存当前形态。
          // 【无中生有】只覆盖【君侧】本次转化出口，不改写实体牌本身；若当前询问不接受【无中生有】，该出口自然不可用。
          xd_junce: {
            enable: "chooseToUse",
            mark: true,
            marktext: "侧",
            init(player) {
              lib.skill.xd_junce.getMask(player);
              player.markSkill("xd_junce");
            },
            onremove(player) {
              delete player.storage.xd_junce_mask;
              delete player._xd_junce_pendingSnapshots;
              if (typeof player.syncStorage === "function") player.syncStorage("xd_junce_mask");
            },
            names: ["sha", "jiu", "tiesuo", "shan", "tao", "guohe"],
            initialMask: 7,
            normalizeMask(mask) {
              const skill = lib.skill.xd_junce;
              mask = Math.floor(Number(mask));
              if (!Number.isFinite(mask) || mask <= 0 || mask >= 63) mask = skill.initialMask;
              mask &= 63;
              // 两侧整体互换不算新形态：统一把含【杀】的一侧规范为 0 侧。
              if (!(mask & 1)) mask = 63 ^ mask;
              if (mask <= 0 || mask >= 63) mask = skill.initialMask;
              return mask;
            },
            getMask(player) {
              const skill = lib.skill.xd_junce;
              const mask = skill.normalizeMask(player?.storage?.xd_junce_mask ?? skill.initialMask);
              if (player && player.storage.xd_junce_mask !== mask) {
                player.storage.xd_junce_mask = mask;
                if (typeof player.syncStorage === "function") player.syncStorage("xd_junce_mask");
              }
              return mask;
            },
            setMask(player, mask) {
              const skill = lib.skill.xd_junce;
              player.storage.xd_junce_mask = skill.normalizeMask(mask);
              if (typeof player.syncStorage === "function") player.syncStorage("xd_junce_mask");
              player.markSkill("xd_junce");
            },
            getSides(player, mask) {
              const skill = lib.skill.xd_junce;
              const value = skill.normalizeMask(mask ?? skill.getMask(player));
              const sides = [[], []];
              skill.names.forEach((name, index) => sides[value & 1 << index ? 0 : 1].push(name));
              return sides;
            },
            getSideIndex(player, name, mask) {
              const skill = lib.skill.xd_junce;
              const index = skill.names.indexOf(name);
              if (index < 0) return -1;
              const value = skill.normalizeMask(mask ?? skill.getMask(player));
              return value & 1 << index ? 0 : 1;
            },
            formatSide(names) {
              return names.map(name => "【" + get.translation(name) + "】").join("/");
            },
            formatState(player, mask) {
              const sides = lib.skill.xd_junce.getSides(player, mask);
              return lib.skill.xd_junce.formatSide(sides[0]) + " ｜ " + lib.skill.xd_junce.formatSide(sides[1]);
            },
            intro: {
              content(storage, player) {
                return "当前形态：<br>" + lib.skill.xd_junce.formatState(player);
              }
            },
            getChooseToUseEvent(start) {
              let current = start || _status.event, guard = 0;
              while (current && guard++ < 24) {
                if (current.name === "chooseToUse") return current;
                let parent = null;
                try {
                  parent = typeof current.getParent === "function" ? current.getParent() : current.parent;
                } catch (e) {
                  parent = current.parent;
                }
                if (!parent || parent === current) break;
                current = parent;
              }
              return null;
            },
            // 与【神机】同口径：判定“在这个具体 chooseToUse 时点，假如有这张牌，它能否被合法使用”。
            isUsableName(name, event, player) {
              if (!event || event.name !== "chooseToUse" || typeof event.filterCard !== "function") return false;
              const card = get.autoViewAs({ name, isCard: true }, "unsure");
              const old = _status._xd_junce_check;
              _status._xd_junce_check = true;
              try {
                if (!event.filterCard.call(event, card, player, event)) return false;
                const info = get.info(card, false);
                if (!info || typeof info.multicheck === "function" && !info.multicheck(card, player)) return false;
                if (info.notarget) return true;
                const range = lib.filter.selectTarget(card, player);
                if (!range || range[0] <= 0 || range[1] === -1) return true;
                const filterTarget = typeof event.filterTarget === "function" ? event.filterTarget : lib.filter.filterTarget;
                return game.filterPlayer(target => {
                  try {
                    return !!filterTarget(card, player, target);
                  } catch (e) {
                    return false;
                  }
                }).length >= range[0];
              } catch (e) {
                return false;
              } finally {
                if (old === undefined) delete _status._xd_junce_check;
                else _status._xd_junce_check = old;
              }
            },
            getNeedState(event, player) {
              const skill = lib.skill.xd_junce;
              return skill.getSides(player).map(names => {
                const usable = names.filter(name => skill.isUsableName(name, event, player));
                return {
                  names,
                  usable,
                  unique: usable.length === 1 ? usable[0] : null
                };
              });
            },
            isJunceCard(card, player) {
              if (!card || get.itemtype(card) !== "card" || !lib.skill.xd_junce.names.includes(card.name)) return false;
              const position = get.position(card);
              if (position === "h") return true;
              if (position !== "s") return false;
              try {
                return player.getVCards("e", current => current.name === "muniu")
                  .some(muniu => muniu?.storages && muniu.storages.includes(card));
              } catch (e) {
                return false;
              }
            },
            getMaterialCards(player, sideNames) {
              const allowed = new Set(sideNames || []);
              return player.getCards("hs").filter(card => lib.skill.xd_junce.isJunceCard(card, player) && allowed.has(card.name));
            },
            // 对每一侧先找“当前可用牌名”。恰有一个时，该底层牌名的【君侧】出口临时显示为【无中生有】。
            // 注意：改名之后仍必须被当前 chooseToUse 本身接受，所以“请使用【闪】”时不会凭空放行【无中生有】。
            getOptions(event, player) {
              if (!event || event.name !== "chooseToUse" || event.responded) return [];
              const skill = lib.skill.xd_junce;
              const states = skill.getNeedState(event, player);
              const options = [];
              for (let targetSide = 0; targetSide < 2; targetSide++) {
                const sourceSide = 1 - targetSide;
                if (!skill.getMaterialCards(player, states[sourceSide].names).length) continue;
                const target = states[targetSide];
                if (target.unique) {
                  if (skill.isUsableName("wuzhong", event, player)) {
                    options.push({ useName: "wuzhong", baseName: target.unique, targetSide, unique: true });
                  }
                  continue;
                }
                for (const name of target.usable) {
                  options.push({ useName: name, baseName: name, targetSide, unique: false });
                }
              }
              return options;
            },
            getUseNames(event, player) {
              return [...new Set(lib.skill.xd_junce.getOptions(event, player).map(item => item.useName))];
            },
            // 选完“要当成什么牌”以后，材料牌阶段不再回头重算外层 chooseToUse。
            // 外层合法性已在 getOptions 中确认；此时只需确认实体材料来自目标牌名的另一侧。
            getBackupSnapshot(event, player, useName) {
              const skill = lib.skill.xd_junce;
              const options = skill.getOptions(event, player).filter(item => item.useName === useName);
              const targetBases = [null, null];
              for (const item of options) targetBases[item.targetSide] = item.baseName;
              return { useName, targetBases, mask: skill.getMask(player) };
            },
            getPairFromSnapshot(player, card, snapshot, requireAccessible = true) {
              const skill = lib.skill.xd_junce;
              if (!snapshot || !card || get.itemtype(card) !== "card" || !skill.names.includes(card.name)) return null;
              if (requireAccessible && !skill.isJunceCard(card, player)) return null;
              const sourceName = card.name;
              const sourceSide = skill.getSideIndex(player, sourceName, snapshot.mask);
              if (sourceSide < 0) return null;
              const targetSide = 1 - sourceSide;
              const targetBase = snapshot.targetBases?.[targetSide];
              if (!targetBase) return null;
              return {
                sourceName,
                targetBase,
                useName: snapshot.useName,
                sourceSide,
                targetSide
              };
            },
            filter(event, player) {
              return lib.skill.xd_junce.getOptions(event, player).length > 0;
            },
            chooseButton: {
              dialog(event, player) {
                const skill = lib.skill.xd_junce;
                const options = skill.getOptions(event, player);
                const names = [...new Set(options.map(item => item.useName))];

                // 这里拿到的 event 就是本次真正的 chooseToUse。
                // 立即把每个出口对应的底层牌名/分组快照保存下来；后续 backup 已进入子事件，
                // 不再沿父事件链重新寻找 chooseToUse，避免材料牌阶段丢失映射。
                const snapshots = Object.create(null);
                for (const name of names) snapshots[name] = skill.getBackupSnapshot(event, player, name);
                player._xd_junce_pendingSnapshots = snapshots;

                const list = names.map(name => [get.type({ name }, null, false) === "basic" ? "基本" : "锦囊", "", name]);
                const dialog = ui.create.dialog("君侧：选择要视为使用的牌", [list, "vcard"]);
                dialog.addText("当前形态：" + skill.formatState(player), true);
                const aura = options.filter(item => item.unique && item.useName === "wuzhong");
                if (aura.length) {
                  dialog.addText("临时【无中生有】：" + aura.map(item => "【" + get.translation(item.baseName) + "】为其所在侧当前唯一可用牌名").join("；"), true);
                }
                return dialog;
              },
              filter(button, player) {
                const event = _status.event.getParent();
                const name = button?.link?.[2];
                return !!name && !!event && lib.skill.xd_junce.getUseNames(event, player).includes(name);
              },
              check(button) {
                const player = get.player();
                const name = button?.link?.[2];
                return name ? player.getUseValue({ name, isCard: true }) : 0;
              },
              backup(links, backupPlayer) {
                const player = backupPlayer || get.player();
                const useName = links?.[0]?.[2] || "sha";
                const snapshot = player?._xd_junce_pendingSnapshots?.[useName];
                // 快照必须来自刚刚那一次牌名选择。这里绝不再猜父事件。
                // 正常原生流程一定已经经过 dialog；若异常缺失，则宁可禁止本次材料选择，也不误判另一侧。
                if (player?._xd_junce_pendingSnapshots) delete player._xd_junce_pendingSnapshots;
                const safeSnapshot = snapshot || { useName, targetBases: [null, null], mask: lib.skill.xd_junce.getMask(player) };

                // 把本次“底层目标牌名”快照随虚拟牌带进 useCard/respond，后续不再倒查 chooseToUse。
                const viewAs = {
                  name: useName,
                  isCard: true,
                  _xd_junce: true,
                  _xd_junce_mask: safeSnapshot.mask,
                  _xd_junce_base0: safeSnapshot.targetBases[0],
                  _xd_junce_base1: safeSnapshot.targetBases[1]
                };
                return {
                  position: "hs",
                  selectCard: 1,
                  popname: true,
                  log: false,
                  sourceSkill: "xd_junce",
                  viewAs,
                  filterCard(card, player) {
                    const snap = {
                      useName: viewAs.name,
                      mask: viewAs._xd_junce_mask,
                      targetBases: [viewAs._xd_junce_base0, viewAs._xd_junce_base1]
                    };
                    return !!lib.skill.xd_junce.getPairFromSnapshot(player, card, snap, true);
                  },
                  check(card) {
                    const player = get.player();
                    const snap = {
                      useName: viewAs.name,
                      mask: viewAs._xd_junce_mask,
                      targetBases: [viewAs._xd_junce_base0, viewAs._xd_junce_base1]
                    };
                    if (!lib.skill.xd_junce.getPairFromSnapshot(player, card, snap, true)) return 0;
                    return 7 - get.value(card, player) + player.getUseValue({ name: viewAs.name, isCard: true }) * 0.15;
                  }
                };
              },
              prompt(links) {
                const useName = links?.[0]?.[2] || "sha";
                return "发动【君侧】：选择另一侧的一张牌当【" + get.translation(useName) + "】使用";
              }
            },
            hiddenCard(player, name) {
              const event = _status.event;
              if (!event || event.name !== "chooseToUse") return false;
              return lib.skill.xd_junce.getUseNames(event, player).includes(name);
            },
            isJunceUse(event) {
              const name = event?.skill;
              if (name === "xd_junce" || name === "xd_junce_backup") return true;
              if (!name) return !!event?.card?._xd_junce;
              try {
                return get.info(name)?.sourceSkill === "xd_junce" || !!event?.card?._xd_junce;
              } catch (e) {
                return !!event?.card?._xd_junce;
              }
            },
            getPairFromUse(event, player) {
              const skill = lib.skill.xd_junce;
              if (!Array.isArray(event?.cards) || event.cards.length !== 1) return null;
              // 一般情况下自定义快照会随 viewAs 进入 event.card；同时从动态 backup 技能保留一个兜底，
              // 避免某些无名杀版本在生成虚拟牌时只复制 name/nature 等标准字段。
              let meta = event.card;
              if (!meta?._xd_junce) {
                try {
                  const info = event.skill ? get.info(event.skill) : null;
                  if (info?.sourceSkill === "xd_junce" && info.viewAs?._xd_junce) meta = info.viewAs;
                } catch (e) {}
              }
              if (!meta?._xd_junce) return null;
              const snapshot = {
                useName: event.card?.name || meta.name,
                mask: meta._xd_junce_mask,
                targetBases: [meta._xd_junce_base0, meta._xd_junce_base1]
              };
              return skill.getPairFromSnapshot(player, event.cards[0], snapshot, false);
            },
            getMoveChoices(player, sourceName, targetBase) {
              const skill = lib.skill.xd_junce;
              const mask = skill.getMask(player);
              const sides = skill.getSides(player, mask);
              const sourceSide = skill.getSideIndex(player, sourceName, mask);
              const targetSide = skill.getSideIndex(player, targetBase, mask);
              if (sourceSide < 0 || targetSide < 0 || sourceSide === targetSide) return [];
              const sourceIndex = skill.names.indexOf(sourceName);
              const targetIndex = skill.names.indexOf(targetBase);
              const choices = [];
              if (sides[sourceSide].length > 1) {
                let next = mask;
                if (sourceSide === 0) next &= ~(1 << sourceIndex);
                else next |= 1 << sourceIndex;
                next = skill.normalizeMask(next);
                choices.push({
                  key: "source",
                  mask: next,
                  label: "将【" + get.translation(sourceName) + "】移至【" + get.translation(targetBase) + "】一侧"
                });
              }
              if (sides[targetSide].length > 1) {
                let next = mask;
                if (targetSide === 0) next &= ~(1 << targetIndex);
                else next |= 1 << targetIndex;
                next = skill.normalizeMask(next);
                choices.push({
                  key: "target",
                  mask: next,
                  label: "将【" + get.translation(targetBase) + "】移至【" + get.translation(sourceName) + "】一侧"
                });
              }
              return choices;
            },
            group: ["xd_junce_commit"],
            subSkill: {
              backup: {},
              commit: {
                charlotte: true,
                forced: true,
                popup: false,
                firstDo: true,
                trigger: {
                  player: ["useCardBefore", "respondBefore"]
                },
                filter(event, player) {
                  if (event._xd_junce_committed || !lib.skill.xd_junce.isJunceUse(event)) return false;
                  return !!lib.skill.xd_junce.getPairFromUse(event, player);
                },
                async content(event, trigger, player) {
                  const skill = lib.skill.xd_junce;
                  if (trigger._xd_junce_committed) return;
                  trigger._xd_junce_committed = true;
                  const pair = skill.getPairFromUse(trigger, player);
                  if (!pair) {
                    if (typeof trigger.cancel === "function") trigger.cancel();
                    return;
                  }
                  const choices = skill.getMoveChoices(player, pair.sourceName, pair.targetBase);
                  if (!choices.length) {
                    if (typeof trigger.cancel === "function") trigger.cancel();
                    return;
                  }

                  let chosen = choices[0];
                  if (choices.length > 1) {
                    const result = await player.chooseControl(choices.map(item => item.label))
                      .set("prompt", "【君侧】：将本次建立转化关系的两个牌名移至同侧")
                      .set("ai", function () {
                        const choices = get.event().xd_junce_choices || [];
                        if (choices.length < 2) return 0;
                        const score = item => {
                          const sides = lib.skill.xd_junce.getSides(get.player(), item.mask);
                          return -Math.abs(sides[0].length - sides[1].length);
                        };
                        return score(choices[1]) > score(choices[0]) ? 1 : 0;
                      })
                      .set("xd_junce_choices", choices)
                      .forResult();
                    const index = Math.max(0, choices.findIndex(item => item.label === result.control));
                    chosen = choices[index] || choices[0];
                  }

                  const before = skill.formatState(player);
                  skill.setMask(player, chosen.mask);
                  const after = skill.formatState(player);
                  player.logSkill("xd_junce");
                  game.log(player, "以【君侧】将", "#y【" + get.translation(pair.sourceName) + "】", "与", "#y【" + get.translation(pair.targetBase) + "】", "移至同侧");
                  game.log("【君侧】形态：", "#y" + before, "→", "#y" + after);
                }
              }
            },
            ai: {
              order(item, player) {
                const event = lib.skill.xd_junce.getChooseToUseEvent();
                const names = lib.skill.xd_junce.getUseNames(event, player);
                if (!names.length) return 1;
                return Math.max(...names.map(name => get.order({ name, isCard: true }) || 1)) + 0.05;
              },
              respondSha: true,
              respondShan: true,
              save: true,
              skillTagFilter(player, tag) {
                const event = lib.skill.xd_junce.getChooseToUseEvent();
                const names = lib.skill.xd_junce.getUseNames(event, player);
                if (tag === "respondSha") return names.includes("sha");
                if (tag === "respondShan") return names.includes("shan");
                if (tag === "save") return names.includes("tao") || names.includes("jiu");
              }
            }
          },
          // 稳定实现保留：原 filterCard、递归锁、连续询问和木牛流马均不可简化为普通 viewAs。
          xd_shenji: {
            locked: true,
            mark: true,
            marktext: "机",
            intro: {
              name: "神机记录",
              content(storage, player) {
                const names = player.storage.xd_shenji_record || [];
                return names.length
                  ? "最近使用的即时牌：" + names.map(name => get.translation(name)).join(" → ")
                  : "尚未使用过即时牌";
              }
            },
            // 两个入口共用实体牌范围；木牛流马的 s 区牌仍算手牌。
            isShenjiCard(card, player) {
              if (get.itemtype(card) !== "card") return false;
              const position = get.position(card);
              return position === "h" || position === "s" && player
                .getVCards("e", card => card.name === "muniu")
                .some(muniu => muniu?.storages && muniu.storages.includes(card));
            },
            trigger: { player: "useCardAfter" },
            forced: true,
            silent: true,
            popup: false,
            filter(event) {
              if (!event.card) return false;
              const type = get.type(event.card, null, false);
              return type === "basic" || type === "trick";
            },
            // storage 只用于显示。用牌结算中历史可能已更新，不能用 useCardAfter 的快照判断变牌。
            recentNames(player) {
              return player.getAllHistory("useCard", lib.skill.xd_shenji.filter)
                .slice(-2).map(evt => evt.card.name);
            },
            getLastTwo(player) {
              const names = lib.skill.xd_shenji.recentNames(player);
              if (names[0] && names[1] && names[0] !== names[1]) return names;
            },
            content(event, trigger, player) {
              const names = lib.skill.xd_shenji.recentNames(player).filter(Boolean);
              player.storage.xd_shenji_record = names;
              player.syncStorage("xd_shenji_record");
              player.markSkill("xd_shenji");
              player.removeTip("xd_shenji_record");
              if (names.length) {
                player.addTip("xd_shenji_record", "神机：" + names.map(name => get.translation(name)).join(" → "));
              }
              if (trigger.card?.name !== "wuzhong" || trigger.modSkill?.cardname !== "xd_shenji") return;
              // 无懈必须重启外层 _wuxie；普通请求仅在原 filterCard 不接受无中时继续询问。
              const wuxieEvent = trigger.getParent("_wuxie", true);
              if (typeof wuxieEvent?.goto === "function") {
                wuxieEvent.goto(0);
                return;
              }
              const chooseEvent = trigger.getParent("chooseToUse");
              if (chooseEvent?.player !== player || !chooseEvent._xd_shenji_filterWrapped ||
                  typeof chooseEvent._xd_shenji_originalFilterCard !== "function") return;
              const wuzhong = get.autoViewAs({ name: "wuzhong" }, "unsure");
              if (!chooseEvent._xd_shenji_originalFilterCard.call(chooseEvent, wuzhong, player, chooseEvent)) {
                chooseEvent.goto(0);
              }
            },
            onremove(player) {
              player.removeTip("xd_shenji_record");
              delete player.storage.xd_shenji_record;
              player.syncStorage("xd_shenji_record");
            },
            // 每个 chooseToUse 只包装一次；保留原函数及其 this，额外放行“之→无中”。
            onChooseToUse(event) {
              if (!event?.player || typeof event.filterCard !== "function" || event._xd_shenji_filterWrapped) return;
              const player = event.player, originalFilterCard = event.filterCard;
              event._xd_shenji_originalFilterCard = originalFilterCard;
              event._xd_shenji_filterWrapped = true;
              event.filterCard = function (card, current, evt) {
                const chooseEvent = evt || event, currentPlayer = current || player;
                if (originalFilterCard.call(chooseEvent, card, currentPlayer, chooseEvent)) return true;
                const skill = lib.skill.xd_shenji;
                if (_status._xd_shenji_check || !skill.isShenjiCard(card, currentPlayer)) return false;
                const name = skill.getNeedName(chooseEvent, currentPlayer);
                return !!name && card.name === name && !!currentPlayer.canUse({ name: "wuzhong", isCard: true }, currentPlayer, false);
              };
            },
            isUsable(name, event, player) {
              if (event?.name !== "chooseToUse" || typeof event.filterCard !== "function") return false;
              const card = get.autoViewAs({ name }, "unsure");
              const filterCard = event._xd_shenji_originalFilterCard || event.filterCard;
              if (!filterCard.call(event, card, player, event)) return false;
              const info = get.info(card, false);
              if (!info || typeof info.multicheck === "function" && !info.multicheck(card, player)) return false;
              if (info.notarget) return true;
              const range = lib.filter.selectTarget(card, player);
              if (!range || range[0] <= 0 || range[1] === -1) return true;
              const filterTarget = typeof event.filterTarget === "function" ? event.filterTarget : lib.filter.filterTarget;
              return game.filterPlayer(target => filterTarget(card, player, target)).length >= range[0];
            },
            getNeedName(event, player) {
              if (event?.name !== "chooseToUse" || _status._xd_shenji_check) return;
              const skill = lib.skill.xd_shenji, names = skill.getLastTwo(player);
              if (!names) return;
              // 合法性检查会再次查询牌名。锁只覆盖本次检查，异常时也必须释放，不能缓存跨询问结果。
              _status._xd_shenji_check = true;
              try {
                const first = skill.isUsable(names[0], event, player);
                const second = skill.isUsable(names[1], event, player);
                if (first !== second) return first ? names[0] : names[1];
              } finally {
                delete _status._xd_shenji_check;
              }
            },
            mod: {
              cardname(card, player) {
                const skill = lib.skill.xd_shenji;
                if (_status._xd_shenji_check || !skill.isShenjiCard(card, player)) return;
                const name = skill.getNeedName(get.event(), player);
                if (!name) return;
                // “之”本身是杀时，也应先变无中，不能落到“杀→之”。
                if (card.name === name) return "wuzhong";
                if (card.name === "sha") return name;
              }
            }
          },
          // 清风提供的稳定实现；发动率、花色比及拒绝发动时取牌的时序保持原样。
          xd_dingding: {
            audio: 2,
            trigger: {
              global: 'useCardAfter'
            },
            filter(event, player) {
              return event.targets?.includes(player);
            },
            init(player) {
              if (!player.storage.xd_dingding) player.storage.xd_dingding = 0;
              if (!player.storage.xd_dingding_card) player.storage.xd_dingding_card = [];
              if (!player.storage.xd_dingding_gain) player.storage.xd_dingding_gain = false;
            },
            mark: true,
            intro: {
              markcount(storage, player) {
                var num = player.getAllHistory('useSkill', evt => evt.skill == 'xd_dingding').length;
                return num + '/' + ((storage ?? 0) + num);
              },
              content(storage, player) {
                var num = player.getAllHistory('useSkill', evt => evt.skill == 'xd_dingding').length;
                return '发动次数/总次数：' + num + '/' + ((storage ?? 0) + num);
              }
            },
            async cost(event, trigger, player) {
              const prompt = '是否发动' + get.translation(event.skill) + (player.storage.xd_dingding_gain && player.storage.xd_dingding_card?.length ? '，若取消发动，则获得' + get.translation(player.storage.xd_dingding_card) : '？');
              event.result = await player.chooseToDiscard('he', prompt).set('ai', card => {
                if (player.storage.xd_dingding_gain) return 0;
                return get.suit(card) != get.suit(trigger.card);
              }).forResult();
              if (!event.result?.bool) {
                player.storage.xd_dingding++;
                if (player.storage.xd_dingding_card?.length && player.storage.xd_dingding_gain) {
                  await player.gain(player.storage.xd_dingding_card, 'gain2');
                  player.storage.xd_dingding_gain = false;
                  player.storage.xd_dingding_card = [];
                }
              }
            },
            async content(event, trigger, player) {
              var card = event.cards[0];
              var {
                result
              } = await player.judge();
              var suits = [get.suit(trigger.card), get.suit(card), result.suit].toUniqued();
              var cards = [];
              game.getGlobalHistory('cardMove', evt => {
                if (evt.name == 'lose' && evt.position == ui.discardPile || evt.name == 'cardsDiscard') {
                  cards.addArray(evt.cards.filterInD('d'));
                }
              });
              var suitx = cards.map(card => get.suit(card)).toUniqued();
              suits = suits.filter(suit => suitx.includes(suit));
              var s = player.getAllHistory('useSkill', evt => evt.skill == 'xd_dingding').length;
              var ss = player.storage.xd_dingding + s;
              if (suits.length / suitx.length > s / ss) {
                player.storage.xd_dingding_gain = true;
                player.popup('归心');
                if (trigger.cards?.length) player.storage.xd_dingding_card.addArray(trigger.cards);
                player.storage.xd_dingding_card.addArray([card, result.card]);
              } else {
                player.popup('失心');
              }
            }
          }
        },
        translate: {
          ...legacy.skillTranslate,
          xd_hong: "弘",
          xd_hong_info: "锁定技，你登场和离场时将本武将牌当【闪电】使用。",
          xd_ren: "仁",
          xd_ren_info: "锁定技，受到你的伤害改为摸牌，你判定后摸一张牌。",
          xd_hui: "诲",
          xd_hui_info: "锁定技，你手牌变为最多后用武将牌堆判定并置之于某体力值上，其上技能每轮总发动次数小于等于此体力值。",
          xd_kongqiu_engine: "孔丘规则引擎",
          xd_yuanyuan: "冤冤",
          xd_yuanyuan_info: "锁定技，弃牌阶段开始时，你移出任意张牌令任意名其他角色视为对你使用【杀】。当你或你以此法指定过的角色使用牌后，你移去一张同类牌以与其各摸一张牌，若因此移去了所有牌，此回合中，其视为拥有本技能且你对其造成的伤害改为其体力值。",
          xd_fenjiao: "偾骄",
          xd_fenjiao_info: "锁定技，当你一回合失去共至少X张牌后（X为你体力上限与额定摸牌数之差），你调整额定摸牌数（X须为正），体力上限+1，本回合不能使用牌。",
          xd_jiaobing: "矫兵",
          xd_jiaobing_info: "锁定技，若如下做后X未增加，你以移出方式使用牌并摸牌至X张。（X为点数大于手牌数的移出牌数）",
          xd_jizhi: "辑志",
          xd_jizhi_trade: "辑志",
          xd_jizhi_info: "其他角色出牌阶段限一次，其可以交给你多张合法目标数相同的牌，你令其获得【辑志】或【合纵】。",
          xd_hezong: "合纵",
          xd_hezong_info: "转换技，阳：你可以视为使用一张即时牌；阴：当与你发动过同名技能的其他角色失去你上次以此法使用的牌后，有【辑志】的角色摸一张牌。",
          xd_lianheng: "连横",
          xd_lianheng_info: "转换技，锁定技，阳：你；阴：你上次使用牌的目标<br>以重铸方式使用牌。",
          xd_haifeng: "海锋",
          xd_haifeng_global: "海锋",
          xd_haifeng_info: "每名角色可以将多张合法目标数不同的牌当【杀】使用，额外指定等量与你发动过同名技能的角色为目标。",
          xd_lian: "涟",
          xd_lian_info: "你可以将【闪】当任意即时牌使用，令你一个技能于你再使用X张牌之前或之后失效。（X为此牌目标数）",
          xd_lian_state: "涟",
          xd_lian_state_info: "【涟】产生的技能失效状态。",
          xd_su: "溯",
          xd_su_info: "锁定技，在你的回合内，你的手牌除目标外视为弃牌堆顶的即时牌。",
          xd_toulao: "投醪",
          xd_toulao_info: "每轮限X次，你需要使用【杀】时使用牌无效，你摸牌可改为增加等量攻击频率或额定摸牌数。（X为两者之差）",
          xd_qiusuo: "求索",
          xd_qiusuo_info: "你可以拼点至输以视为使用一张牌，从所有即时拼点牌的目标和效果中组合，然后判定【闪电】，结果由最终赢家从所有拼点牌的花色和点数中组合。",
          xd_tianwen: "天问",
          xd_tianwen_info: "你拼点时可选择与牌堆顶的牌或用牌堆顶的牌拼点。",
          xd_qian: "欺暗",
          xd_qian_info: "锁定技，在你的回合内，其他角色按点数从左向右递增排列手牌，且于失去边缘的手牌后令你摸一张牌。",
          xd_qiming: "欺明",
          xd_qiming_info: "锁定技，当你使用牌后，你明置目标一张牌，若与使用牌点数相同，你获得之，否则其重铸一张暗置牌。",
          visible_xd_qiming: "明置",
          xd_liebing: "裂兵",
          xd_liebing_use: "裂兵",
          xd_liebing_info: "锁定技，每轮限0.5次，你仅能将目标为你/其他角色的手牌当【无中生有】/【杀】使用。",
          xd_naoji: "挠击",
          xd_naoji_info: "锁定技，你使用牌后攻击范围、攻击频率、技能限制次数+0.1，你造成伤害后翻倍你一个技能的数值。",
          xd_yangkuang: '阳狂',
          xd_yangkuang_info: '当你脱离受伤或无手牌状态后，你可以与当前回合角色各摸一张牌并各视为使用【酒】。',
          xd_cihuang: '雌黄',
          xd_cihuang_info: '有牌被抵消后，你可以将一张牌当任意即时牌对使用者使用，三者目标数与你本轮使用次数皆须≤1。',
          xd_sanku: '三窟',
          xd_sanku_info: '锁定技，当你进入濒死状态时，你减少1点体力上限并回复所有体力。',
          xd_jiji: '击楫',
          xd_jiji_info: '当即时牌进入弃牌堆后，你可以移出或移去一张同名牌。<br>你一回合使用X张牌后可以摸至X张（X为移出牌数）。<br>若你发动本行的次数最少，你可以视为使用一张移出牌。',
          xd_xuebian: '穴变',
          xd_xuebian_info: '灼然·若本阶段没有角色使用/获得牌，你可以将你场上一张牌当【无懈可击】/【洞烛先机】使用。<br>谬敬·若你的体力值/手牌数等于上限，你可以将至少半数手牌当【桃园结义】/【出其不意】使用。<br>挽驾·若场上没有武器牌/与你势力不同的角色，你可以视为使用【借刀杀人】/【远交近攻】。<br>结算后，若上文的所有前半句皆不满足，你交换之。',
          xd_xiangfu: '相赴',
          xd_xiangfu_info: '每轮各限一次，你可以与一名其他角色将手牌向彼此调整一张，按差值变化视为使用牌：<br>相思·正负性不变，【杀】；相逢·变为0，【酒】；<br>相失·变为相反数，【闪】；相守·未变化，【桃】。',
          xd_yixin: '一心',
          xd_yixin_info: '锁定技，唯一参与【相赴】的其他角色视为拥有之。',
          xd_quxing: '曲兴',
          xd_quxing_info: '出牌阶段，你可以将多张同名牌置于一名其他角色的武将牌上，并与其各摸等量张牌，直到你下次或其下次发动技能，你获得或其使用「曲兴」同名牌后重铸之。',
          xd_wulan: '舞阑',
          xd_wulan_info: '你可以于你阶段结束后预先执行三轮后的同一阶段，令本回合结束时唯一有「曲兴」牌的角色使用或视为使用所有即时「曲兴」牌，并将之目标转移至你。',
          xd_quxing_holder: '曲兴',
          xd_wulan_effect: '舞阑',
          xd_qingding: '倾鼎',
          xd_qingding_info: '锁定技，每回合限一次，当你摸牌、回复体力、造成伤害时，若你本轮执行过：仅一项，多执行一次；另两项，防止之；所有项，删除本行。',
          xd_yuwei: '逾围',
          xd_yuwei_info: '你可以以移出方式使用牌并摸牌至X张，令本技能于你使用X张牌前失效、失效X回合后失去。（X为上一张移出牌点数）',
          xd_longsha: '龙沙',
          xd_longsha_info: '锁定技，你使用牌后重铸花色或类型顺序与你最近使用牌相同的连续X张移出牌，否则移去一张牌，否则依次移出至多X张牌并摸等量张牌。（X恰为你半数手牌）',
          xd_buping: '布枰',
          xd_buping_info: '每轮限X+1次，你可以令一名其他角色替你使用你需要使用的牌，其如此做后与你各摸一张牌，否则你弃置X张牌或对本次技能未指定的其他角色重复此流程。（X为此流程重复次数的最大值）',
          xd_zhenwu: '镇物',
          xd_zhenwu_info: '锁定技，所有角色于你曾需要使用基本牌的回合翻倍、明置、于回合结束时弃置其摸的牌。',
          xd_fuding: '扶鼎',
          xd_fuding_info: '你可以将任意张牌当任意即时牌使用，令你此次与下次使用牌的目标须共满足以下项：1. 手牌数为某底牌点数；2. 体力值为某底牌字数；3. 为各底牌的合法目标。',
          visible_xd_zhenwu: '明置',
          xd_moved_out_tag: 'invisible',
          xd_dingding: '定鼎',
          xd_dingding_info: '以你为目标的牌结算后，你可以弃置一张牌并进行判定，若三者花色于本回合弃牌堆占比大于本技能发动率，你下次拒绝发动本技能时获得这三者。',
          xd_juemo: '绝漠',
          xd_juemo_info: '当你使用基本牌/黑色牌/伤害牌后，你可以摸一张牌并明置之，令你下次使用牌须满足剩余项，无剩余项则将一项改为“明置牌”。',
          xd_juemo_tag: '明置',
          xd_jiedu: '解渡',
          xd_jiedu_info: '当你成为牌的目标时，你可以与使用者同时明置任意张牌，若两者有相同花色，你重铸你所有明置牌或转移此牌的唯一目标。',
          visible_xd_jiedu: '明置',
          xd_youren: '游刃',
          xd_youren_info: '锁定技，若你使用基本牌和摸两张牌的次数相同，你使用「杀」无次数限制，锦囊牌视为「无中生有」。',
          xd_junce: '君侧',
          xd_junce_info: '你可以将【杀/酒/铁索连环】、【闪/桃/过河拆桥】当另一侧一张牌使用并将两者移至同侧。任意侧唯一需要使用的牌名改为【无中生有】。',
          xd_shenji: '神机',
          xd_shenji_info: '锁定技，当你需要使用你上两次使用的即时牌中的唯一一张时，你将「杀」当之或将之当「无中生有」使用。',
          xd_sijiao: '饲骄',
          xd_sijiao_tag: '明置',
          xd_sijiao_info: '锁定技，你使用牌时执行首个可执行项：重铸0张明置基本牌；明置一张牌；摸牌至两张；以上数值+1。',
          xd_congzu: '从卒',
          xd_congzu_info: '转换技，锁定技，阳：你以重铸的方式使用基本牌；阴：你的攻击频率+X。',
          xd_yibian: '亦变',
          xd_yibian_info: '转换技，锁定技，阳：你以重铸的方式使用锦囊牌；阴：你的额定摸牌数+X。',
          xd_bailian: '百炼',
          xd_bailian_info: '锁定技，当你使用牌指定不为其他角色的目标后，将本句移至你另一技能当前项（X为本句触发次数）。',
          xd_hujia: '胡笳',
          xd_hujia_info: '锁定技，你的手牌恒为三张。你能防止本技能失去。<br>你不能改变手牌顺序，使用牌前须明置另一张牌。',
          visible_xd_hujia: '明置',
          xd_liuhe: '六合',
          xd_liuhe_info: '锁定技，你各手牌位皆有过明暗置牌后复原觉醒技。',
          xd_bahuang: '八荒',
          xd_bahuang_info: '锁定技，你达成手牌所有明暗置顺序后复原觉醒技。',
          xd_shiyuan: '时愿',
          xd_shiyuan_info: '觉醒技，当你脱离濒死状态后，上次使用牌的角色令你获得【六合】或失去所有技能以获得【归雁】。',
          xd_jieqing: '竭情',
          xd_jieqing_info: '觉醒技，当你脱离受伤状态后，你获得【八荒】或删除【胡笳】的第二行。',
          xd_caiyan_sort: '整理手牌',
          xd_caiyan_sort_info: '出牌阶段，你可以调整手牌顺序。',
          xd_guiyan: '归雁',
          xd_guiyan_info: '锁定技，你于回合内依次使用左侧第一、二、三张手牌后，将上一阶段或本回合下一阶段改为出牌阶段。',
          bolyuba: '欲罢',
          bolyuba_info:'当你造成或受到伤害后，你可以弃置一张X点牌或失去一个技能以摸牌至X张（X为拒绝发动本技能次数）。',
          bolxingjiang: '行将',
          bolxingjiang_info:'出牌阶段限一次，你可以弃置至少两张同名即时牌，将之效果化为一个“每轮限一次”的技能。',
          xd_mei: '寐',
          xd_mei_info: '转换技，阳：你失去暗置牌后，可以闭上一只眼；阴：你失去明置牌后，可以睁开一只眼。',
          xd_meng: '梦',
          xd_meng_info:'你可以以暗置方式使用牌，然后重铸所有与之同花色的明置牌并闭上双眼，否则，你下次仅能发动【醒】。',
          xd_xing: '醒',
          xd_xing_info: '你可以睁开双眼并以明置方式使用牌，然后重铸所有与之同花色的暗置牌，否则，你下次仅能发动【梦】。',
          xd_shown_cards_viewer: '明置牌'
        }
      },
      "intro": "《风雨如晦（上）》。玄蝶 著。ChatGPT、Claude 开发；ChatGPT 绘壁纸与界面；Grace_Davis 测试打磨；清风、蝶设堂、无名杀团队 贡献代码。",
      "name": "风雨如晦（上）",
      "author": "玄蝶",
      "diskURL": "https://mega.nz/folder/qR8THbyS#arC5aKkgewdlV5_zXzeWew",
      "forumURL": "https://www.bilibili.com/opus/1107326926420181009",
      "version": ZHUANGZHOU_TEST_SCAFFOLD ? "39/39-v355-test" : "39/39"
    },
    files: {
      "character": [],
      "card": [],
      "skill": [],
      "audio": []
    },
    connect: false
  };
}
;
