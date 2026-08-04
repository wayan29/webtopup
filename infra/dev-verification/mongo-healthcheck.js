const hello = db.hello();
if (!hello.isWritablePrimary || hello.setName !== 'rs0') {
  quit(1);
}
quit(0);
