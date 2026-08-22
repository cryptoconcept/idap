import { Schema, model, models, type Model, type InferSchemaType } from "mongoose";

/**
 * Atomic sequence generator. One document per (scope) key, e.g.
 * `INS0001:LEAD` or `INS0001:APPLICATION`, incremented with findOneAndUpdate so
 * concurrent requests can never receive the same number.
 */
const CounterSchema = new Schema(
  {
    _id: { type: String, required: true },
    seq: { type: Number, default: 0 },
  },
  { collection: "counters", versionKey: false },
);

export type CounterDoc = InferSchemaType<typeof CounterSchema>;

export const Counter: Model<CounterDoc> =
  (models.Counter as Model<CounterDoc>) ?? model<CounterDoc>("Counter", CounterSchema);
