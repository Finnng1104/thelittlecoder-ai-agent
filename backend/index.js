require("dotenv").config();
const { Telegraf } = require("telegraf");

const telegramToken = process.env.TELEGRAM_TOKEN;

if (!telegramToken) {
  throw new Error("Missing TELEGRAM_TOKEN in backend/.env");
}

const bot = new Telegraf(telegramToken);

bot.start((ctx) => {
  ctx.reply(
    "Chao Tien! Toi la Pet AI cua ban day. Go gi do di, toi se nhai lai cho ban xem!"
  );
});

bot.help((ctx) => {
  ctx.reply("Hien tai toi co the nhai lai tin nhan. Sap toi toi se biet dang bai FB!");
});

bot.on("text", (ctx) => {
  const chatId = String(ctx.chat.id);
  const userText = ctx.message.text;
  const ownerChatId = String(process.env.MY_CHAT_ID || "");

  if (chatId === ownerChatId) {
    ctx.reply(`Tien vua noi: "${userText}". Toi da nghe ro!`);
    return;
  }

  ctx.reply("Ban khong phai chu nhan cua toi. Mien tiep!");
  console.log(`[bot] Warning: stranger message from chat ID ${chatId}`);
});

bot.launch().then(() => {
  console.log("[bot] Telegram bot is online and waiting for commands...");
});

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
