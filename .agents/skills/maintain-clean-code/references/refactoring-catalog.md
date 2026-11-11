# Refactoring catalog

Condensed from [refactoring.guru](https://refactoring.guru/refactoring). Use it to go
from a **smell** you noticed to a **named refactoring** that fixes it. Examples are
about this repo's TypeScript style (pure functions in `lib/`, thin adapters in
`extensions/`), not classic Java classes: where a catalog entry says "class", a module
or a plain object of functions is usually the right size here.

Refactoring means changing structure without changing behaviour. Keep tests green at
every step, and keep it separate from feature or fix commits.

## Code smells

### Bloaters (code that grew too big)

| Smell | Signs | Fix |
|---|---|---|
| Long Method | Function over ~20 lines, comments marking sections, several loops or branches | Extract Method; Replace Temp with Query; Introduce Parameter Object; Preserve Whole Object; Replace Method with Method Object; Decompose Conditional |
| Large Class | A module or object with many fields, many responsibilities, or thousands of lines | Extract Class; Extract Subclass; Extract Interface |
| Primitive Obsession | Strings and numbers for ids, modes, states; string constants for field names | Replace Data Value with Object; Introduce Parameter Object; Replace Type Code with Class / Subclasses / State; use a string-literal union |
| Long Parameter List | More than 3 or 4 parameters | Replace Parameter with Method Call; Preserve Whole Object; Introduce Parameter Object |
| Data Clumps | The same group of values travels together (`host, port, user`) | Extract Class; Introduce Parameter Object; Preserve Whole Object |

### Object-Orientation Abusers

| Smell | Signs | Fix |
|---|---|---|
| Switch Statements | Long `switch` or `if` chain on a type, repeated in several places | Extract Method + Move Method; Replace Type Code with Subclasses or State/Strategy; Replace Conditional with Polymorphism; Introduce Null Object. In TypeScript a lookup table or discriminated union is often enough |
| Temporary Field | Fields set only in some code paths | Extract Class; Introduce Null Object |
| Refused Bequest | Subclass ignores most of what it inherits | Replace Inheritance with Delegation; Extract Superclass |
| Alternative Classes with Different Interfaces | Two units do the same thing under different names | Rename Method; Move Method; Extract Superclass |

### Change Preventers (one change forces many edits)

| Smell | Signs | Fix |
|---|---|---|
| Divergent Change | One module changes for many unrelated reasons | Extract Class |
| Shotgun Surgery | One change touches many modules | Move Method; Move Field; Inline Class |
| Parallel Inheritance Hierarchies | Adding a subclass here forces one there | Move Method; Move Field |

### Dispensables (things that should not exist)

| Smell | Signs | Fix |
|---|---|---|
| Comments | A comment explains what confusing code does | Extract Variable; Extract Method; Rename Method; Introduce Assertion |
| Duplicate Code | Same or near-same block in two places | Extract Method; Pull Up Field/Method; Form Template Method; Substitute Algorithm |
| Lazy Class | A unit that does too little to justify itself | Inline Class; Collapse Hierarchy |
| Data Class | Only fields and getters, no behaviour | Move Method onto it; Encapsulate Field/Collection; Remove Setting Method |
| Dead Code | Unused variable, parameter, function, branch or export | Delete it (and its test). Run `npm run lint:dead` |
| Speculative Generality | Hooks, params or abstractions for "someday" | Collapse Hierarchy; Inline Class; Inline Method; Remove Parameter; Rename Method |

### Couplers (too much coupling)

| Smell | Signs | Fix |
|---|---|---|
| Feature Envy | A function reaches into another module's data more than its own | Move Method; Extract Method then Move |
| Inappropriate Intimacy | Two modules read each other's internals | Move Method/Field; Change Bidirectional Association to Unidirectional; Extract Class; Hide Delegate |
| Message Chains | `a.getB().getC().getD()` | Hide Delegate; Extract Method + Move Method |
| Middle Man | A unit only forwards calls | Remove Middle Man; Inline Method |
| Incomplete Library Class | You need behaviour the library lacks | Introduce Foreign Method; Introduce Local Extension |

## Refactoring techniques

### Composing Methods
Extract Method · Inline Method · Extract Variable · Inline Temp · Replace Temp with Query ·
Split Temporary Variable · Remove Assignments to Parameters · Replace Method with Method
Object · Substitute Algorithm.

### Moving Features between Objects
Move Method · Move Field · Extract Class · Inline Class · Hide Delegate · Remove Middle
Man · Introduce Foreign Method · Introduce Local Extension.

### Organizing Data
Self Encapsulate Field · Replace Data Value with Object · Change Value to Reference ·
Change Reference to Value · Replace Array with Object · Duplicate Observed Data · Change
Unidirectional Association to Bidirectional · Change Bidirectional to Unidirectional ·
Replace Magic Number with Symbolic Constant · Encapsulate Field · Encapsulate Collection ·
Replace Type Code with Class / Subclasses / State/Strategy · Replace Subclass with Fields.

### Simplifying Conditional Expressions
Decompose Conditional · Consolidate Conditional Expression · Consolidate Duplicate
Conditional Fragments · Remove Control Flag · Replace Nested Conditional with Guard
Clauses · Replace Conditional with Polymorphism · Introduce Null Object · Introduce
Assertion.

### Simplifying Method Calls
Rename Method · Add Parameter · Remove Parameter · Separate Query from Modifier ·
Parameterize Method · Replace Parameter with Explicit Methods · Preserve Whole Object ·
Replace Parameter with Method Call · Introduce Parameter Object · Remove Setting Method ·
Hide Method · Replace Constructor with Factory Method · Replace Error Code with Exception ·
Replace Exception with Test.

### Dealing with Generalization
Pull Up Field · Pull Up Method · Pull Up Constructor Body · Push Down Method · Push Down
Field · Extract Subclass · Extract Superclass · Extract Interface · Collapse Hierarchy ·
Form Template Method · Replace Inheritance with Delegation · Replace Delegation with
Inheritance.

## Worked example: Decompose a decision out of an adapter

Smell: Long Method + Feature Envy. `extensions/foo.ts` has a tool handler that parses
input, decides whether to proceed, and calls Pi. It can only be tested through a Pi session.

1. Pin behaviour with a characterization test of the handler's observable result.
2. **Extract Method** for the decision into a local function with explicit inputs.
3. **Move Method** the function to `lib/foo-policy.ts`, exporting only what the handler imports.
4. Replace hidden reads (`process.env`, `Date.now()`) with explicit parameters (Add
   Parameter), so a test controls them.
5. Add direct unit tests in `tests/foo-policy.test.ts` for the boundaries.
6. Handler becomes: parse, call policy, act on the answer.
7. Run `npm run tidy` and `npm run lint:dead`. Commit as `refactor(foo): extract decision into lib/foo-policy`.
