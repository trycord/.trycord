// The signed-out surfaces, and the backend picker.
//
//   public/auth.js      sign in, register, forgot, reset
//   public/legal.js     the terms and privacy documents, and email verification
//   public/backend.js   which instance this device talks to
//
// The router sends /login, /register, /legal/terms and /settings/backend here, which is
// the only thing they had in common besides the file.

import { loginForm, registerForm, forgotForm, resetPasswordPage } from './auth.js';
import { legalPage, verifyEmailPage } from './legal.js';
import { renderBackendSelector } from './backend.js';

const PagesPublic = {
  login: loginForm,
  register: registerForm,
  forgot: forgotForm,
  resetPassword: resetPasswordPage,
  legal: legalPage,
  verify: verifyEmailPage,
};

export { renderBackendSelector };
export default PagesPublic;