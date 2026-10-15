//! The inputs.ts of a group: the input types of its models, which requests
//! have in place of the models. An input type leaves out the fields the
//! document marks read-only, as a client doesn't send them, and has the
//! input types of the models it holds.

use std::collections::HashSet;

use forge::ts::{File, p};
use forge::{Method, Model, Type};

use super::Node;
use super::client::{Encoding, Request};
use super::models::print_fields;
use super::types::{Prec, Side, doc, has_fields, input_ident, input_typ, kept, needs_input};

/// Returns the inputs.ts of `node`: the input type of each model of the
/// node that [`input_models`] has. A node without any has an empty
/// inputs.ts, which isn't written.
pub(super) fn inputs(node: Node<'_>) -> File {
    let mut f = File::new(node.dir().sub("inputs.ts"));
    for (i, m) in input_models(node).into_iter().enumerate() {
        if i > 0 {
            p!(f);
        }
        f.doc(&doc(m.description(), m.is_deprecated()));
        let ty = m.ty();
        match ty {
            Type::Object(object) if has_fields(ty) => {
                p!(f, "export interface ", input_ident(m), " {");
                print_fields(&mut f, object, Side::Write);
                p!(f, "}");
            }
            _ => p!(f, "export type ", input_ident(m), " = ", input_typ(ty, Prec::Top), ";"),
        }
    }
    f
}

/// Returns the models placed in `node`, sorted by schema name, that have
/// an input type: those that [`needs_input`] reports, and that a request
/// holds. Every method that uses a model is in the model's group or below
/// it, so only the requests of those methods are walked.
pub(super) fn input_models(node: Node<'_>) -> Vec<Model<'_>> {
    let methods: Vec<Method<'_>> = match node {
        Node::Root(forge) => forge.groups().flat_map(|g| g.methods()).collect(),
        Node::Group(group) => std::iter::once(group)
            .chain(group.descendants())
            .flat_map(|g| g.methods())
            .collect(),
    };
    let mut held = HashSet::new();
    for m in methods {
        let request = Request::new(m);
        for param in &request.params {
            hold(param.field.ty(), &mut held);
        }
        let Some(body) = &request.body else {
            continue;
        };
        match (body.encoding, &body.parts) {
            (Encoding::Json, _) => hold(body.ty, &mut held),
            (Encoding::Multipart | Encoding::Form, Some(parts)) => {
                for field in parts.iter().flat_map(|part| &part.fields) {
                    if !field.is_read_only() {
                        hold(field.ty(), &mut held);
                    }
                }
            }
            (Encoding::Multipart | Encoding::Form, None) | (Encoding::Raw { .. }, _) => {}
        }
    }
    node.models().into_iter().filter(|m| held.contains(m)).collect()
}

/// Adds to `held` each model with an input type that a request's `t`
/// holds, as [`input_typ`] prints it. A model that needs no input type
/// holds none.
fn hold<'f>(t: Type<'f>, held: &mut HashSet<Model<'f>>) {
    match t {
        Type::Model(m) => {
            if needs_input(m) && held.insert(m) {
                hold(m.ty(), held);
            }
        }
        Type::Array(array) => hold(array.elem(), held),
        Type::Object(object) => {
            for field in object.fields() {
                if kept(field) && !field.is_read_only() {
                    hold(field.ty(), held);
                }
            }
            if let Some(extra) = object.extra() {
                hold(extra, held);
            }
        }
        Type::Union(union) => union.members().for_each(|m| hold(m, held)),
        Type::Intersection(intersection) => intersection.members().for_each(|m| hold(m, held)),
        Type::Scalar(_) | Type::Enum(_) => {}
    }
}
