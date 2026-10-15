import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  array,
  bytes,
  type Codec,
  discriminated,
  int64,
  intersection,
  isRecord,
  map,
  object,
  parse,
  set,
  toBase64,
  union,
} from '../src/codec.js';
import { date, instant } from '../src/dates.js';

// A codec that tags what it converts, to see which codec ran on a value.
function tag(name: string): Codec {
  return {
    decode: (value) => `${name}(${String(value)})`,
    encode: (value) => `${name}'(${String(value)})`,
  };
}

// Replaces globalThis.Temporal with nothing for the length of fn.
function withoutTemporal(fn: () => void): void {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'Temporal');
  assert.ok(descriptor, 'run the tests with --harmony-temporal');
  Reflect.deleteProperty(globalThis, 'Temporal');
  try {
    fn();
  } finally {
    Object.defineProperty(globalThis, 'Temporal', descriptor);
  }
}

describe('isRecord', () => {
  test('accepts plain objects', () => {
    assert.equal(isRecord({}), true);
    assert.equal(isRecord({ a: 1 }), true);
    assert.equal(isRecord(Object.create(null)), true);
    assert.equal(isRecord(JSON.parse('{"a":1}')), true);
  });

  test('rejects everything else', () => {
    for (const value of [
      null,
      undefined,
      0,
      '',
      'text',
      true,
      [],
      [1],
      new Date(),
      new Map(),
      new Uint8Array(),
      new (class Box {
        value = 1;
      })(),
      Object.create({}),
      () => {},
    ]) {
      assert.equal(isRecord(value), false, `isRecord(${String(value)})`);
    }
  });
});

describe('set', () => {
  test('sets an ordinary key', () => {
    const target: { [key: string]: unknown } = {};
    set(target, 'a', 1);
    assert.deepEqual(target, { a: 1 });
  });

  test('sets __proto__ as an own key, keeping the prototype', () => {
    const target: { [key: string]: unknown } = {};
    set(target, '__proto__', { polluted: true });
    assert.equal(Object.getPrototypeOf(target), Object.prototype);
    assert.deepEqual(Object.keys(target), ['__proto__']);
    assert.deepEqual(Object.getOwnPropertyDescriptor(target, '__proto__'), {
      value: { polluted: true },
      enumerable: true,
      writable: true,
      configurable: true,
    });
    assert.equal(({} as { polluted?: boolean }).polluted, undefined);
  });
});

describe('parse', () => {
  test('parses JSON as JSON.parse does', () => {
    const text = '{"a":[1,2.5,"x",null,true],"b":{"c":1234567890123456}}';
    assert.deepEqual(parse(text), JSON.parse(text));
    assert.deepEqual(parse('12345678901234567890'), Number('12345678901234567890'));
  });

  test('throws on invalid JSON', () => {
    assert.throws(() => parse('{'), SyntaxError);
    assert.throws(() => parse('{"a":12345678901234567890'), SyntaxError);
  });

  test('keeps the digits of large integers in objects', () => {
    const codec = object([['id', null, int64]]);
    assert.deepEqual(codec.decode(parse('{"id":12345678901234567890}')), {
      id: 12345678901234567890n,
    });
    assert.deepEqual(codec.decode(parse('{"id":-98765432109876543210}')), {
      id: -98765432109876543210n,
    });
  });

  test('keeps the digits of large integers in arrays and maps', () => {
    assert.deepEqual(array(int64).decode(parse('[1, 12345678901234567890, null]')), [1n, 12345678901234567890n, null]);
    assert.deepEqual(map(int64).decode(parse('{"a":12345678901234567890,"b":2}')), {
      a: 12345678901234567890n,
      b: 2n,
    });
  });

  test('keeps the digits of large integers in nested values', () => {
    const codec = object([['items', null, array(object([['id', null, int64]]))]]);
    assert.deepEqual(codec.decode(parse('{"items":[{"id":9007199254740993},{"id":9007199254740995}]}')), {
      items: [{ id: 9007199254740993n }, { id: 9007199254740995n }],
    });
  });

  test('does not keep the source of numbers that are not integers', () => {
    // An exponent is not the digits of an integer, so the value is the
    // number JSON.parse gives.
    const value = parse('{"id":12345678901234567890e0}');
    assert.deepEqual(object([['id', null, int64]]).decode(value), {
      id: BigInt(Number('12345678901234567890')),
    });
  });
});

describe('object', () => {
  test('renames keys and converts values', () => {
    const codec = object([
      ['user_name', 'userName'],
      ['value', null, tag('v')],
      ['created_at', 'createdAt', tag('t')],
    ]);
    assert.deepEqual(codec.decode({ user_name: 'a', value: 1, created_at: 2, other: 3 }), {
      userName: 'a',
      value: 'v(1)',
      createdAt: 't(2)',
      other: 3,
    });
    assert.deepEqual(codec.encode({ userName: 'a', value: 1, createdAt: 2, other: 3 }), {
      user_name: 'a',
      value: "v'(1)",
      created_at: "t'(2)",
      other: 3,
    });
  });

  test('keeps the order of keys', () => {
    const codec = object([['b_b', 'bB']]);
    assert.deepEqual(Object.keys(codec.decode({ a: 1, b_b: 2, c: 3 }) as object), ['a', 'bB', 'c']);
  });

  test('renames but does not convert null and undefined', () => {
    const codec = object([['a_a', 'aA', tag('x')]]);
    assert.deepEqual(codec.decode({ a_a: null }), { aA: null });
    assert.deepEqual(codec.encode({ aA: null }), { a_a: null });
    assert.deepEqual(codec.encode({ aA: undefined }), { a_a: undefined });
  });

  test('keeps values that are not plain objects', () => {
    const codec = object([['a', 'b']]);
    const values = [null, undefined, 1, 'a', [{ a: 1 }], new Date(0)];
    for (const value of values) {
      assert.equal(codec.decode(value), value);
      assert.equal(codec.encode(value), value);
    }
  });

  test('does not change its input', () => {
    const codec = object([['a', 'b', tag('x')]]);
    const input = { a: 1 };
    const output = codec.decode(input);
    assert.notEqual(output, input);
    assert.deepEqual(input, { a: 1 });
  });

  test('keeps a __proto__ key as data', () => {
    const codec = object([['__proto__', 'proto']]);
    const decoded = codec.decode(JSON.parse('{"__proto__":{"a":1}}'));
    assert.deepEqual(decoded, { proto: { a: 1 } });

    const kept = object([]).decode(JSON.parse('{"__proto__":{"a":1}}'));
    assert.equal(Object.getPrototypeOf(kept), Object.prototype);
    assert.deepEqual(Object.keys(kept as object), ['__proto__']);
  });

  test('resolves codec functions once, on first use', () => {
    let calls = 0;
    const codec = object([
      [
        'a',
        null,
        () => {
          calls++;
          return tag('x');
        },
      ],
    ]);
    assert.equal(calls, 0);
    codec.decode({ a: 1 });
    codec.decode({ a: 2 });
    assert.equal(calls, 1);
    codec.encode({ a: 1 });
    assert.equal(calls, 2);
  });

  test('supports cycles', () => {
    const node: Codec = object([
      ['value', null, int64],
      ['child_nodes', 'children', () => array(node)],
    ]);
    const wire = {
      value: 1,
      child_nodes: [{ value: 2, child_nodes: [{ value: 3, child_nodes: [] }] }],
    };
    const decoded = {
      value: 1n,
      children: [{ value: 2n, children: [{ value: 3n, children: [] }] }],
    };
    assert.deepEqual(node.decode(wire), decoded);
    assert.deepEqual(JSON.parse(JSON.stringify(node.encode(decoded))) as unknown, wire);
  });
});

describe('array', () => {
  test('converts items', () => {
    const codec = array(tag('x'));
    assert.deepEqual(codec.decode([1, 2]), ['x(1)', 'x(2)']);
    assert.deepEqual(codec.encode([1, 2]), ["x'(1)", "x'(2)"]);
  });

  test('keeps null items, and undefined items when encoding', () => {
    const codec = array(tag('x'));
    assert.deepEqual(codec.decode([null, 1]), [null, 'x(1)']);
    assert.deepEqual(codec.encode([null, undefined, 1]), [null, undefined, "x'(1)"]);
  });

  test('keeps values that are not arrays', () => {
    const codec = array(tag('x'));
    for (const value of [null, undefined, 1, 'ab', { 0: 1, length: 1 }]) {
      assert.equal(codec.decode(value), value);
      assert.equal(codec.encode(value), value);
    }
  });

  test('resolves codec functions', () => {
    const codec = array(() => tag('x'));
    assert.deepEqual(codec.decode([1]), ['x(1)']);
  });
});

describe('map', () => {
  test('converts values and keeps keys', () => {
    const codec = map(tag('x'));
    assert.deepEqual(codec.decode({ a_b: 1, c: null }), {
      a_b: 'x(1)',
      c: null,
    });
    assert.deepEqual(codec.encode({ a_b: 1, c: null, d: undefined }), {
      a_b: "x'(1)",
      c: null,
      d: undefined,
    });
  });

  test('keeps a __proto__ key as data', () => {
    const decoded = map(tag('x')).decode(JSON.parse('{"__proto__":1}'));
    assert.equal(Object.getPrototypeOf(decoded), Object.prototype);
    assert.equal(Object.getOwnPropertyDescriptor(decoded, '__proto__')?.value, 'x(1)');
  });

  test('keeps values that are not plain objects', () => {
    const codec = map(tag('x'));
    for (const value of [null, undefined, 1, 'ab', [1]]) {
      assert.equal(codec.decode(value), value);
      assert.equal(codec.encode(value), value);
    }
  });
});

describe('union and intersection', () => {
  for (const [name, combine] of [
    ['union', union],
    ['intersection', intersection],
  ] as const) {
    test(`${name} converts with each member in order`, () => {
      const codec = combine([tag('a'), () => tag('b')]);
      assert.equal(codec.decode(1), 'b(a(1))');
      assert.equal(codec.encode(1), "b'(a'(1))");
    });

    test(`${name} passes the source to each member`, () => {
      const codec = combine([object([['id', null, int64]]), object([])]);
      assert.deepEqual(codec.decode(parse('{"id":12345678901234567890}')), {
        id: 12345678901234567890n,
      });
    });

    test(`${name} of object members converts each member's keys`, () => {
      const codec = combine([object([['a_a', 'aA']]), object([['b_b', 'bB', int64]])]);
      assert.deepEqual(codec.decode({ a_a: 1, b_b: 2 }), { aA: 1, bB: 2n });
    });

    test(`${name} with no members keeps the value`, () => {
      const value = { a: 1 };
      assert.equal(combine([]).decode(value), value);
      assert.equal(combine([]).encode(value), value);
    });
  }
});

describe('discriminated', () => {
  const codec = discriminated('kind_name', 'kindName', {
    cat: object([
      ['kind_name', 'kindName'],
      ['lives', null, int64],
    ]),
    dog: () =>
      object([
        ['kind_name', 'kindName'],
        ['good_boy', 'goodBoy'],
      ]),
    1: object([['kind_name', 'kindName']]),
  });

  test('converts with the member the property names', () => {
    assert.deepEqual(codec.decode({ kind_name: 'cat', lives: 9 }), {
      kindName: 'cat',
      lives: 9n,
    });
    assert.deepEqual(codec.decode({ kind_name: 'dog', good_boy: true }), {
      kindName: 'dog',
      goodBoy: true,
    });
    assert.deepEqual(JSON.stringify(codec.encode({ kindName: 'cat', lives: 9n })), '{"kind_name":"cat","lives":9}');
    assert.deepEqual(codec.encode({ kindName: 'dog', goodBoy: true }), {
      kind_name: 'dog',
      good_boy: true,
    });
  });

  test('matches values that are not strings by their text', () => {
    assert.deepEqual(codec.decode({ kind_name: 1 }), { kindName: 1 });
  });

  test('keeps values of an unknown member', () => {
    for (const value of [
      { kind_name: 'bird' },
      { kind_name: 'toString' },
      { kind_name: '__proto__' },
      { kindName: 'cat' },
      {},
    ]) {
      assert.equal(codec.decode(value), value);
    }
    const encoded = { kind_name: 'cat' };
    assert.equal(codec.encode(encoded), encoded);
  });

  test('keeps values that are not plain objects', () => {
    for (const value of [null, undefined, 'cat', ['cat']]) {
      assert.equal(codec.decode(value), value);
      assert.equal(codec.encode(value), value);
    }
  });

  test('reads the wire name when the property is not renamed', () => {
    const plain = discriminated('type', null, { a: object([['x_x', 'xX']]) });
    assert.deepEqual(plain.decode({ type: 'a', x_x: 1 }), { type: 'a', xX: 1 });
    assert.deepEqual(plain.encode({ type: 'a', xX: 1 }), { type: 'a', x_x: 1 });
  });

  test('passes the source to the member', () => {
    const decoded = object([['pet', null, codec]]).decode(
      parse('{"pet":{"kind_name":"cat","lives":12345678901234567890}}'),
    );
    assert.deepEqual(decoded, {
      pet: { kindName: 'cat', lives: 12345678901234567890n },
    });
  });
});

describe('instant', () => {
  test('decodes a date-time string', () => {
    const value = instant.decode('2024-01-02T03:04:05.678Z');
    assert.ok(value instanceof Temporal.Instant);
    assert.equal(value.epochMilliseconds, Date.UTC(2024, 0, 2, 3, 4, 5, 678));

    const offset = instant.decode('2024-01-02T05:04:05+02:00');
    assert.ok(offset instanceof Temporal.Instant);
    assert.equal(offset.toString(), '2024-01-02T03:04:05Z');
  });

  test('keeps strings that are not date-times, and other values', () => {
    for (const value of ['', 'yesterday', '2024-01-02', 0, null, {}]) {
      assert.equal(instant.decode(value), value);
    }
  });

  test('encodes an instant as its string', () => {
    const value = Temporal.Instant.from('2024-01-02T03:04:05Z');
    assert.equal(instant.encode(value), '2024-01-02T03:04:05Z');
    assert.equal(JSON.stringify({ at: value }), '{"at":"2024-01-02T03:04:05Z"}');
  });

  test('keeps values that are not objects when encoding', () => {
    for (const value of ['2024-01-02T03:04:05Z', 0, null, undefined]) {
      assert.equal(instant.encode(value), value);
    }
  });

  test('throws when Temporal is missing', () => {
    withoutTemporal(() => {
      assert.throws(() => instant.decode('2024-01-02T03:04:05Z'), ReferenceError);
    });
  });
});

describe('date', () => {
  test('decodes a date string', () => {
    const value = date.decode('2024-02-29');
    assert.ok(value instanceof Temporal.PlainDate);
    assert.deepEqual([value.year, value.month, value.day], [2024, 2, 29]);
  });

  test('keeps strings that are not dates, and other values', () => {
    for (const value of ['', '2023-02-29', 'tomorrow', 20240101, null]) {
      assert.equal(date.decode(value), value);
    }
  });

  test('encodes a date as its string', () => {
    assert.equal(date.encode(Temporal.PlainDate.from('2024-02-29')), '2024-02-29');
    assert.equal(date.encode('2024-02-29'), '2024-02-29');
    assert.equal(date.encode(null), null);
  });

  test('throws when Temporal is missing', () => {
    withoutTemporal(() => {
      assert.throws(() => date.decode('2024-01-02'), ReferenceError);
    });
  });
});

describe('toBase64', () => {
  test('encodes bytes', () => {
    assert.equal(toBase64(new Uint8Array()), '');
    assert.equal(toBase64(new TextEncoder().encode('hello')), 'aGVsbG8=');
    assert.equal(toBase64(new Uint8Array([0xfb, 0xff])), '+/8=');
  });

  test("encodes more bytes than fit in one call's arguments", () => {
    const data = new Uint8Array(0x8000 * 3 + 7).map((_, i) => i * 31);
    assert.equal(toBase64(data), Buffer.from(data).toString('base64'));
  });
});

describe('bytes', () => {
  test('decodes base64', () => {
    assert.deepEqual(bytes.decode('aGVsbG8='), new TextEncoder().encode('hello'));
    assert.deepEqual(bytes.decode(''), new Uint8Array());
  });

  test('round-trips every byte value', () => {
    const data = new Uint8Array(256).map((_, i) => i);
    assert.deepEqual(bytes.decode(bytes.encode(data)), data);
  });

  test('keeps strings that are not base64, and other values', () => {
    for (const value of ['not base64!', 'a', 0, null, [1, 2]]) {
      assert.equal(bytes.decode(value), value);
    }
  });

  test('encodes a Uint8Array and keeps other values', () => {
    assert.equal(bytes.encode(new Uint8Array([1, 2, 3])), 'AQID');
    for (const value of ['AQID', [1, 2, 3], null, new ArrayBuffer(3)]) {
      assert.equal(bytes.encode(value), value);
    }
  });
});

describe('int64', () => {
  test('decodes integers as bigints', () => {
    assert.equal(int64.decode(0), 0n);
    assert.equal(int64.decode(-42), -42n);
    assert.equal(int64.decode(Number.MAX_SAFE_INTEGER), BigInt(Number.MAX_SAFE_INTEGER));
  });

  test('decodes from the source text when there is one', () => {
    assert.equal(int64.decode(Number('9223372036854775807'), '9223372036854775807'), 9223372036854775807n);
  });

  test('keeps values that are not integers', () => {
    for (const value of [1.5, Number.NaN, Infinity, '1', null, 1n]) {
      assert.equal(int64.decode(value), value);
    }
  });

  test('encodes a bigint as a JSON number with every digit', () => {
    assert.equal(JSON.stringify({ id: int64.encode(-9223372036854775808n) }), '{"id":-9223372036854775808}');
    assert.equal(JSON.stringify([int64.encode(0n)]), '[0]');
  });

  test('keeps values that are not bigints', () => {
    for (const value of [1, '1', null, undefined]) {
      assert.equal(int64.encode(value), value);
    }
  });

  test('round-trips through parse', () => {
    const codec = object([['id', null, int64]]);
    const text = '{"id":-9223372036854775808}';
    assert.equal(JSON.stringify(codec.encode(codec.decode(parse(text)))), text);
  });
});
