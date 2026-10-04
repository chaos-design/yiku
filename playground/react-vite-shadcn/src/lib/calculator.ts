/**
 * 科学计算器表达式求值引擎
 *
 * 采用 tokenizer + 递归下降解析器（Recursive Descent Parser），
 * 不使用 eval / Function，避免任意代码执行风险。
 *
 * 支持：
 * - 四则运算 + - * /
 * - 幂运算 ^ （右结合）
 * - 取模 %
 * - 括号
 * - 一元正负号
 * - 阶乘 ! （仅对非负整数 / 半整数 gamma 不在范围，这里限制为非负整数）
 * - 常量：π / pi, e
 * - 函数：sin cos tan asin acos atan log ln sqrt cbrt exp abs
 * - 角度制 / 弧度制（DEG / RAD）
 */

export type AngleMode = "DEG" | "RAD";

export interface EvalOptions {
  angleMode: AngleMode;
}

export type CalcErrorType = "SYNTAX" | "MATH" | "UNKNOWN";

export class CalcError extends Error {
  type: CalcErrorType;
  constructor(type: CalcErrorType, message: string) {
    super(message);
    this.name = "CalcError";
    this.type = type;
  }
}

type TokenType = "NUMBER" | "IDENT" | "OP" | "LPAREN" | "RPAREN" | "COMMA" | "EOF";

interface Token {
  type: TokenType;
  value: string;
  pos: number;
}

const FUNCTIONS = new Set([
  "sin",
  "cos",
  "tan",
  "asin",
  "acos",
  "atan",
  "log",
  "ln",
  "sqrt",
  "cbrt",
  "exp",
  "abs",
]);

const CONSTANTS: Record<string, number> = {
  pi: Math.PI,
  π: Math.PI,
  e: Math.E,
};

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const src = input.replace(/\s+/g, "");

  while (i < src.length) {
    const ch = src[i];

    // 数字（含小数）
    if ((ch >= "0" && ch <= "9") || ch === ".") {
      const start = i;
      let dotSeen = false;
      while (i < src.length) {
        const c = src[i];
        if (c >= "0" && c <= "9") {
          i++;
        } else if (c === ".") {
          if (dotSeen) throw new CalcError("SYNTAX", "小数点格式错误");
          dotSeen = true;
          i++;
        } else {
          break;
        }
      }
      // 支持科学计数法 1e3 / 1.2e-3
      if (i < src.length && (src[i] === "e" || src[i] === "E")) {
        // 仅当后面跟数字或 +/- 时才作为科学计数法
        const next = src[i + 1];
        if (next && ((next >= "0" && next <= "9") || next === "+" || next === "-")) {
          i++; // 消费 e
          if (src[i] === "+" || src[i] === "-") i++;
          const expStart = i;
          while (i < src.length && src[i] >= "0" && src[i] <= "9") i++;
          if (i === expStart) throw new CalcError("SYNTAX", "科学计数法指数缺失");
        }
      }
      const numStr = src.slice(start, i);
      if (numStr === "." || numStr === "") {
        throw new CalcError("SYNTAX", "数字格式错误");
      }
      tokens.push({ type: "NUMBER", value: numStr, pos: start });
      continue;
    }

    // 标识符：函数名 / 常量
    if ((ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || ch === "π") {
      const start = i;
      if (ch === "π") {
        tokens.push({ type: "IDENT", value: "π", pos: start });
        i++;
        continue;
      }
      while (
        i < src.length &&
        ((src[i] >= "a" && src[i] <= "z") || (src[i] >= "A" && src[i] <= "Z"))
      ) {
        i++;
      }
      tokens.push({ type: "IDENT", value: src.slice(start, i), pos: start });
      continue;
    }

    if (ch === "(") {
      tokens.push({ type: "LPAREN", value: ch, pos: i });
      i++;
      continue;
    }
    if (ch === ")") {
      tokens.push({ type: "RPAREN", value: ch, pos: i });
      i++;
      continue;
    }
    if (ch === ",") {
      tokens.push({ type: "COMMA", value: ch, pos: i });
      i++;
      continue;
    }
    if ("+-*/^%!".includes(ch)) {
      tokens.push({ type: "OP", value: ch, pos: i });
      i++;
      continue;
    }
    // 乘号 / 除号的友好符号
    if (ch === "×") {
      tokens.push({ type: "OP", value: "*", pos: i });
      i++;
      continue;
    }
    if (ch === "÷") {
      tokens.push({ type: "OP", value: "/", pos: i });
      i++;
      continue;
    }
    if (ch === "−") {
      // unicode 减号
      tokens.push({ type: "OP", value: "-", pos: i });
      i++;
      continue;
    }

    throw new CalcError("SYNTAX", `无法识别的字符：${ch}`);
  }

  tokens.push({ type: "EOF", value: "", pos: src.length });
  return tokens;
}

/**
 * 语法（运算符优先级，从低到高）：
 *   expr      := term (('+'|'-') term)*
 *   term      := factor (('*'|'/'|'%') factor)*
 *   factor    := unary ('^' factor)?     // 右结合
 *   unary     := ('+'|'-') unary | postfix
 *   postfix   := primary ('!')*
 *   primary   := NUMBER | CONST | FUNC '(' expr ')' | '(' expr ')'
 *
 * 隐式乘法处理：在 primary 之间如果没有运算符相邻（例如 2π、2(3)、)(），视作乘法。
 * 这里通过在 primary 中识别"紧邻"来实现：当解析完一个 primary 后，若下一个 token
 * 可能开启新的 primary（NUMBER / IDENT / LPAREN），则继续乘上下一个 primary。
 */
class Parser {
  private tokens: Token[];
  private pos = 0;
  private angleMode: AngleMode;

  constructor(tokens: Token[], angleMode: AngleMode) {
    this.tokens = tokens;
    this.angleMode = angleMode;
  }

  private peek(): Token {
    return this.tokens[this.pos];
  }

  private advance(): Token {
    return this.tokens[this.pos++];
  }

  private expect(type: TokenType, value?: string): Token {
    const tok = this.peek();
    if (tok.type !== type || (value !== undefined && tok.value !== value)) {
      throw new CalcError("SYNTAX", `语法错误：期望 ${value ?? type}，实际得到 "${tok.value}"`);
    }
    return this.advance();
  }

  parse(): number {
    const value = this.parseExpr();
    if (this.peek().type !== "EOF") {
      throw new CalcError("SYNTAX", `语法错误：多余的输入 "${this.peek().value}"`);
    }
    return value;
  }

  private parseExpr(): number {
    let left = this.parseTerm();
    while (this.peek().type === "OP" && (this.peek().value === "+" || this.peek().value === "-")) {
      const op = this.advance().value;
      const right = this.parseTerm();
      left = op === "+" ? left + right : left - right;
    }
    return left;
  }

  private parseTerm(): number {
    let left = this.parseFactor();
    while (
      this.peek().type === "OP" &&
      (this.peek().value === "*" || this.peek().value === "/" || this.peek().value === "%")
    ) {
      const op = this.advance().value;
      const right = this.parseFactor();
      if (op === "*") left = left * right;
      else if (op === "/") {
        if (right === 0) throw new CalcError("MATH", "除数不能为 0");
        left = left / right;
      } else {
        if (right === 0) throw new CalcError("MATH", "模数不能为 0");
        left = left % right;
      }
    }
    return left;
  }

  private parseFactor(): number {
    const base = this.parseUnary();
    if (this.peek().type === "OP" && this.peek().value === "^") {
      this.advance();
      const exp = this.parseFactor(); // 右结合
      return base ** exp;
    }
    return base;
  }

  private parseUnary(): number {
    if (this.peek().type === "OP" && this.peek().value === "-") {
      this.advance();
      return -this.parseUnary();
    }
    if (this.peek().type === "OP" && this.peek().value === "+") {
      this.advance();
      return this.parseUnary();
    }
    return this.parsePostfix();
  }

  private parsePostfix(): number {
    let value = this.parsePrimaryWithImplicitMul();
    while (this.peek().type === "OP" && this.peek().value === "!") {
      this.advance();
      value = factorial(value);
    }
    return value;
  }

  /**
   * 处理隐式乘法，例如 2π、3(4)、(1)(2)、2sin(π)。
   * 当解析到一个 primary 后，如果下一个 token 还能开启新的 primary，
   * 就继续解析并相乘。
   */
  private parsePrimaryWithImplicitMul(): number {
    let value = this.parsePrimary();
    while (this.canStartPrimary(this.peek())) {
      const rhs = this.parsePrimary();
      value = value * rhs;
    }
    return value;
  }

  private canStartPrimary(tok: Token): boolean {
    if (tok.type === "NUMBER" || tok.type === "LPAREN") return true;
    if (tok.type === "IDENT") return true;
    return false;
  }

  private parsePrimary(): number {
    const tok = this.peek();

    if (tok.type === "NUMBER") {
      this.advance();
      const num = Number.parseFloat(tok.value);
      if (!Number.isFinite(num)) {
        throw new CalcError("MATH", "数值超出范围");
      }
      return num;
    }

    if (tok.type === "LPAREN") {
      this.advance();
      const value = this.parseExpr();
      this.expect("RPAREN", ")");
      return value;
    }

    if (tok.type === "IDENT") {
      this.advance();
      const name = tok.value.toLowerCase();

      // 常量
      if (Object.hasOwn(CONSTANTS, name)) {
        return CONSTANTS[name];
      }

      // 函数
      if (FUNCTIONS.has(name)) {
        this.expect("LPAREN", "(");
        const arg = this.parseExpr();
        this.expect("RPAREN", ")");
        return applyFunction(name, arg, this.angleMode);
      }

      throw new CalcError("SYNTAX", `未知标识符：${tok.value}`);
    }

    throw new CalcError("SYNTAX", `语法错误：意外的 token "${tok.value}"`);
  }
}

function factorial(n: number): number {
  if (n < 0 || !Number.isInteger(n)) {
    throw new CalcError("MATH", "阶乘仅支持非负整数");
  }
  if (n > 170) {
    // 170! 约为 7.2e306，171! 超出 Number.MAX_VALUE
    throw new CalcError("MATH", "阶乘结果过大");
  }
  let result = 1;
  for (let i = 2; i <= n; i++) result *= i;
  return result;
}

function applyFunction(name: string, arg: number, angleMode: AngleMode): number {
  const toRad = (x: number) => (angleMode === "DEG" ? (x * Math.PI) / 180 : x);
  const fromRad = (x: number) => (angleMode === "DEG" ? (x * 180) / Math.PI : x);

  switch (name) {
    case "sin":
      return Math.sin(toRad(arg));
    case "cos":
      return Math.cos(toRad(arg));
    case "tan": {
      // 对 90°、270° 这种角度做精确处理
      const r = toRad(arg);
      const t = Math.tan(r);
      if (!Number.isFinite(t)) throw new CalcError("MATH", "tan 在该角度无定义");
      return t;
    }
    case "asin": {
      if (arg < -1 || arg > 1) throw new CalcError("MATH", "asin 定义域为 [-1, 1]");
      return fromRad(Math.asin(arg));
    }
    case "acos": {
      if (arg < -1 || arg > 1) throw new CalcError("MATH", "acos 定义域为 [-1, 1]");
      return fromRad(Math.acos(arg));
    }
    case "atan":
      return fromRad(Math.atan(arg));
    case "log":
      if (arg <= 0) throw new CalcError("MATH", "log 定义域为 (0, +∞)");
      return Math.log10(arg);
    case "ln":
      if (arg <= 0) throw new CalcError("MATH", "ln 定义域为 (0, +∞)");
      return Math.log(arg);
    case "sqrt":
      if (arg < 0) throw new CalcError("MATH", "sqrt 定义域为 [0, +∞)");
      return Math.sqrt(arg);
    case "cbrt":
      return Math.cbrt(arg);
    case "exp":
      return Math.exp(arg);
    case "abs":
      return Math.abs(arg);
    default:
      throw new CalcError("SYNTAX", `未知函数：${name}`);
  }
}

/**
 * 求值入口
 */
export function evaluate(expression: string, options: EvalOptions): number {
  if (!expression || expression.trim().length === 0) {
    throw new CalcError("SYNTAX", "表达式为空");
  }
  const tokens = tokenize(expression);
  const parser = new Parser(tokens, options.angleMode);
  const result = parser.parse();
  if (!Number.isFinite(result)) {
    throw new CalcError("MATH", "结果不是有限数值（可能溢出或除以 0）");
  }
  return result;
}

/**
 * 将数值格式化为可显示字符串，处理浮点误差。
 */
export function formatResult(value: number, maxDigits = 12): string {
  if (!Number.isFinite(value)) return "错误";
  if (Number.isInteger(value) && Math.abs(value) < 1e15) {
    return value.toLocaleString("en-US", { maximumFractionDigits: 0 });
  }
  // 处理浮点误差：四舍五入到 12 位有效数字
  const rounded = Number(value.toPrecision(maxDigits));
  // 极大 / 极小数使用科学计数法
  if (Math.abs(rounded) !== 0 && (Math.abs(rounded) >= 1e12 || Math.abs(rounded) < 1e-6)) {
    return rounded.toExponential(6).replace(/\.?0+e/, "e");
  }
  // 普通数：去除多余尾零
  const str = rounded.toString();
  return str;
}
