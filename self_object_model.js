class SelfObject {
  constructor({
    slots = {},
    parents = [],       // array of slot names that are marked as "parents"
    messages = null,    // array of message names (strings) or null
    data = null,        // immutable primitive (number/bool/string/...)
    primFn = null,      // function(SelfObject) -> SelfObject
    name = null,        // optional label for printing
  } = {}) {
    this.slots = { ...slots };
    this.parents = [...parents];
    this.messages = messages;
    this.data = data;
    this.primFn = primFn;
    this.name = name;
  }

  // Shallow structural copy (containers copied; references shared)
  shallowCopy() {
    return new SelfObject({
      slots: this.slots,
      parents: this.parents,
      messages: this.messages,
      data: this.data,
      primFn: this.primFn,
      name: this.name,
    });
  }

  // Evaluate per spec:
  // - primFn: clone then primFn(clone)
  // - data: return clone
  // - messages: clone, send each message (propagate parameter if present), return last result
  // - plain: return self
  eval() {
    if (typeof this.primFn === 'function') {
      const clone = this.shallowCopy();
      return this.primFn(clone);
    }
    if (this.data !== null && this.data !== undefined) {
      return this.shallowCopy();
    }
    if (Array.isArray(this.messages)) {
      const clone = this.shallowCopy();
      let last = null;
      for (const msg of clone.messages) {
        if (Object.prototype.hasOwnProperty.call(clone.slots, 'parameter')) {
          last = sendAMessageWithParameters(clone, msg, clone.slots['parameter']);
        } else {
          last = sendAMessage(clone, msg);
        }
      }
      return last ?? clone;
    }
    return this;
  }

  // BFS slot lookup across parent slots (parents are names of slots that point to parent objects)
  lookupBFS(name) {
    if (Object.prototype.hasOwnProperty.call(this.slots, name)) {
      return this.slots[name];
    }
    const visited = new Set([this]);
    const q = [this];
    while (q.length) {
      const cur = q.shift();
      if (Object.prototype.hasOwnProperty.call(cur.slots, name)) {
        return cur.slots[name];
      }
      for (const pName of cur.parents) {
        const parentObj = cur.slots[pName];
        if (parentObj && !visited.has(parentObj)) {
          visited.add(parentObj);
          q.push(parentObj);
        }
      }
    }
    throw new Error(`Slot '${name}' not found via BFS in object or its parents.`);
  }
}

/* ===== Capabilities (assignment API) ===== */

function evaluate(obj) { return obj.eval(); }

function copyObject(obj) { return obj.shallowCopy(); }

function sendAMessage(obj, msg) {
  const target = obj.lookupBFS(msg);
  target.slots['__owner'] = obj;
  if (!target.parents.includes('__owner')) {
    target.parents.push('__owner');
  }
  return evaluate(target);
}


function sendAMessageWithParam(obj, msg, param) {
  const target = obj.lookupBFS(msg);
  target.slots['parameter'] = param;
  target.slots['__owner'] = obj;
  if (!target.parents.includes('__owner')) {
    target.parents.push('__owner');
  }
  return evaluate(target);
}


// Alias with full name (both accepted)
function sendAMessageWithParameters(obj, msg, param) {
  return sendAMessageWithParam(obj, msg, param);
}

function assignSlot(obj, name, value) { obj.slots[name] = value; }

function makeParent(obj, name) {
  if (!Object.prototype.hasOwnProperty.call(obj.slots, name)) {
    throw new Error(`Cannot make parent: slot '${name}' not found`);
  }
  if (!obj.parents.includes(name)) obj.parents.push(name);
}

function assignParentSlot(obj, name, value) {
  assignSlot(obj, name, value);
  makeParent(obj, name);
}

function printObject(obj, maxDepth = 2, depth = 0, seen = new Set()) {
  const indent = '  '.repeat(depth);
  let head = `${indent}Object(`;
  const parts = [];
  if (obj.name) parts.push(`name='${obj.name}'`);
  if (obj.data !== null && obj.data !== undefined) parts.push(`data=${JSON.stringify(obj.data)}`);
  if (obj.primFn) parts.push('prim_fn=<fn>');
  if (Array.isArray(obj.messages)) parts.push(`messages=${JSON.stringify(obj.messages)}`);
  if (obj.parents.length) parts.push(`parents=${JSON.stringify(obj.parents)}`);
  head += parts.join(', ') + ')';
  if (depth >= maxDepth) return head;
  if (seen.has(obj)) return head + '  <...cycle...>';
  seen.add(obj);
  const lines = [head];
  for (const [k, v] of Object.entries(obj.slots)) {
    lines.push(`${indent}  .${k} -> ${printObject(v, maxDepth, depth + 1, new Set(seen))}`);
  }
  return lines.join('\n');
}

/* ===== Helpers (constructors) ===== */

function Data(value, name = null) { return new SelfObject({ data: value, name }); }
function Primitive(fn, name = null) { return new SelfObject({ primFn: fn, name }); }
function MessageBody(messages, name = null) { return new SelfObject({ messages: [...messages], name }); }

/* ===== Tiny Stdlib & Demo Program ===== */

function buildStdlib() {
  const root = new SelfObject({ name: 'root' });

  // + : parameter { lhs, rhs } -> number
  function primAdd(self) {
    const p = self.slots.parameter;
    if (!p) throw new Error('add: missing parameter');
    const lhs = p.lookupBFS('lhs').data;
    const rhs = p.lookupBFS('rhs').data;
    return Data(lhs + rhs, 'sum');
  }
  assignSlot(root, '+', Primitive(primAdd, 'Add'));

  // ifThenElse : parameter { cond(bool or obj->bool), then(message body), else(message body) }
function primIf(self) {
  const p = self.slots.parameter;
  if (!p) throw new Error('if: missing parameter');

  const condObj = p.lookupBFS('cond');
  const thenBody = p.lookupBFS('then');
  const elseBody = p.lookupBFS('else');
  const env = p.lookupBFS('env');
  const setDynEnv = (body) => {
    if (env) {
      body.slots['__owner'] = env;
      if (!body.parents.includes('__owner')) body.parents.push('__owner');
    }
  };
  setDynEnv(condObj);
  setDynEnv(thenBody);
  setDynEnv(elseBody);

  const condVal = (condObj.data !== undefined && condObj.data !== null)
    ? condObj.data
    : condObj.eval().data;

  const chosen = condVal ? thenBody : elseBody;
  return evaluate(chosen);
}


  assignSlot(root, 'ifThenElse', Primitive(primIf, 'If'));

  // dec : parameter { n } -> n-1
  function primDec(self) {
    const n = self.slots.parameter.lookupBFS('n').data;
    return Data(n - 1, 'n-1');
  }
  assignSlot(root, 'dec', Primitive(primDec, 'Dec'));

  // eq0 : parameter { n } -> boolean
  function primEq0(self) {
    const n = self.slots.parameter.lookupBFS('n').data;
    return Data(n === 0, 'isZero');
  }
  assignSlot(root, 'eq0', Primitive(primEq0, 'Eq0'));

  // * : parameter { lhs, rhs } -> product
  function primMul(self) {
    const p = self.slots.parameter;
    const lhs = p.lookupBFS('lhs').data;
    const rhs = p.lookupBFS('rhs').data;
    return Data(lhs * rhs, 'product');
  }
  assignSlot(root, '*', Primitive(primMul, 'Mul'));

  // factorial via recursion: fact(n) = if n==0 then 1 else n * fact(n-1)
  const fact = new SelfObject({ name: 'fact' });
  assignParentSlot(fact, 'lib', root);  // give fact access to stdlib via BFS

  // cond_body -> computeCond
  const cond_body = new SelfObject({ name: 'cond_body', messages: ['computeCond'] });
  assignParentSlot(cond_body, '__owner', fact);     // can see outer fact (for parameter & helpers)
  assignSlot(fact, 'cond_body', cond_body);

  function primComputeCond(self) {
    const p = new SelfObject();
    assignSlot(p, 'n', self.lookupBFS('parameter'));
    return sendAMessageWithParameters(self.lookupBFS('lib'), 'eq0', p);
  }
  assignSlot(fact, 'computeCond', Primitive(primComputeCond, 'computeCond'));

  // then_body -> Data(1)
  assignSlot(fact, 'then_body', Data(1, 'one'));

  // else_body -> computeElse
  const else_body = new SelfObject({ name: 'else_body', messages: ['computeElse'] });
  assignParentSlot(else_body, '__owner', fact);
  assignSlot(fact, 'else_body', else_body);

  function primComputeElse(self) {
    const nObj = self.lookupBFS('parameter');    // n (Data)
    // dec(n)
    const pDec = new SelfObject();
    assignSlot(pDec, 'n', nObj);
    const nMinus1 = sendAMessageWithParameters(self.lookupBFS('lib'), 'dec', pDec);
    // fact(n-1)
    const factCall = fact.shallowCopy();
    assignSlot(factCall, 'parameter', nMinus1);
    const factN1 = evaluate(factCall);
    // n * fact(n-1)
    const pMul = new SelfObject();
    assignSlot(pMul, 'lhs', nObj);
    assignSlot(pMul, 'rhs', factN1);
    return sendAMessageWithParameters(self.lookupBFS('lib'), '*', pMul);
  }
  assignSlot(fact, 'computeElse', Primitive(primComputeElse, 'computeElse'));

  // program: messages ["runIf"]
  const program = new SelfObject({ name: 'program', messages: ['runIf'] });
  assignParentSlot(program, '__owner', fact);
  assignSlot(fact, 'program', program);

 function primRunIf(self) {
  const pIf = new SelfObject();
  const programEnv = self.lookupBFS('__owner');
  const factEnv = programEnv && programEnv.slots['__owner'] ? programEnv.slots['__owner'] : programEnv;

  assignSlot(pIf, 'env', factEnv);
  assignSlot(pIf, 'cond', self.lookupBFS('cond_body'));
  assignSlot(pIf, 'then', self.lookupBFS('then_body'));
  assignSlot(pIf, 'else', self.lookupBFS('else_body'));

  return sendAMessageWithParameters(self.lookupBFS('lib'), 'ifThenElse', pIf);
}

  assignSlot(program, 'runIf', Primitive(primRunIf, 'runIf'));

  // when fact is evaluated: run program
  fact.messages = ['program'];

  // expose
  assignSlot(root, 'fact', fact);

  // Tiny BFS demo (optional)
  const parent = new SelfObject({ name: 'parent' });
  assignSlot(parent, 'x', Data(7));
  const child = new SelfObject({ name: 'child' });
  assignParentSlot(child, 'p', parent);
  assignSlot(root, 'bfsDemoParent', parent);
  assignSlot(root, 'bfsDemoChild', child);

  return root;
}

/* ===== Run demo when executed directly ===== */

function demo() {
  const std = buildStdlib();

  console.log('=== STD LIB (truncated) ===');
  console.log(printObject(std));

  // 1 + 2
  const pAdd = new SelfObject();
  assignSlot(pAdd, 'lhs', Data(1));
  assignSlot(pAdd, 'rhs', Data(2));
  const sumObj = sendAMessageWithParameters(std, '+', pAdd);
  console.log('1 + 2 =', sumObj.data);

  // factorial(5)
  const fact = std.lookupBFS('fact');
  const factCall = fact.shallowCopy();
  assignSlot(factCall, 'parameter', Data(5));
  const res = evaluate(factCall);
  console.log('fact(5) =', res.data);

  // BFS parent demo
  const child = std.lookupBFS('bfsDemoChild');
  console.log("BFS demo 'x' =", sendAMessage(child, 'x').data); // -> 7
}

if (require.main === module) {
  demo();
}

/* ===== Exports (optional for tests) ===== */
module.exports = {
  SelfObject,
  evaluate,
  copyObject,
  sendAMessage,
  sendAMessageWithParam,
  sendAMessageWithParameters,
  assignSlot,
  makeParent,
  assignParentSlot,
  printObject,
  Data,
  Primitive,
  MessageBody,
  buildStdlib,
};
