export class UserModel {
  id: string;
  email: string;
  createdAt: Date;
  updatedAt: Date;

  constructor(data: { id: string; email: string }) {
    this.id = data.id;
    this.email = data.email;
    this.createdAt = new Date();
    this.updatedAt = new Date();
  }
}
