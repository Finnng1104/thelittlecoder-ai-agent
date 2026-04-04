class PostModel {
  constructor({ id, title, content, status = "draft", createdAt = new Date() }) {
    this.id = id;
    this.title = title;
    this.content = content;
    this.status = status;
    this.createdAt = createdAt;
  }
}

module.exports = { PostModel };
