import { hashPassword } from "../auth.ts";

const password = process.env.COMPOSE_PANEL_PASSWORD ?? process.argv[2];
if (!password) {
    console.error("Set COMPOSE_PANEL_PASSWORD (preferred) or pass the password as an argument (visible in shell history).");
    process.exit(1);
}
if (password.length < 12) {
    console.error("Choose a password of at least 12 characters.");
    process.exit(1);
}
console.log(await hashPassword(password));
