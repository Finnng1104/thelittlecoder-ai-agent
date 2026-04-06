function formatForFacebook(text) {
  if (!text) {
    return "";
  }

  return String(text)
    .replace(/\r\n/g, "\n")
    // Xoa dau markdown bold neu AI lo tay chen vao.
    .replace(/\*\*/g, "")
    .replace(/__/g, "")
    // Chuyen heading markdown thanh emoji + uppercase.
    .replace(/^### (.*$)/gim, (_, title) => `💠 ${String(title).toUpperCase()}`)
    // Chuyen markdown divider.
    .replace(/^\s*---+\s*$/gim, "──────────────")
    // Chuan hoa khoang trang.
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    // Dam bao dong tieu de dau tien duoc uppercase.
    .replace(/^.*$/m, (line) => line.toUpperCase());
}

module.exports = { formatForFacebook };

