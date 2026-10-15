//! The index.ts of a group, its public surface (specs/01-output-layout.md).

use std::collections::HashSet;

use forge::ts::{File, Ident, p};

use super::Node;
use super::client::{request_name, response_name};
use super::inputs::input_models;
use super::types::input_ident;

/// Returns the index.ts of `node`: ApiError and RequestOptions from the
/// runtime library, so that every entry point is complete, then
/// createClient and the types of its client, then its models and their
/// input types. A model or input type named like another export is
/// exported with a `$` added.
pub(super) fn index(node: Node<'_>) -> File {
    let mut f = File::new(node.dir().sub("index.ts"));
    let depth = node.depth();
    let mut runtime = format!("{}_/index.js", "../".repeat(depth));
    if depth == 0 {
        runtime.insert_str(0, "./");
    }
    export(&mut f, "export", &["ApiError".to_owned()], &runtime);
    export(&mut f, "export type", &["RequestOptions".to_owned()], &runtime);

    export(&mut f, "export", &["createClient".to_owned()], "./client.js");
    let mut names = vec!["Client".to_owned(), "ClientOptions".to_owned()];
    for m in node.methods() {
        names.push(request_name(m));
        names.push(response_name(m));
    }
    export(&mut f, "export type", &names, "./client.js");

    let mut taken: HashSet<String> = ["ApiError", "RequestOptions"].map(String::from).into();
    taken.extend(names);
    let models: Vec<Ident> = node.models().into_iter().map(Ident::model).collect();
    let models = exported(&models, &mut taken);
    export(&mut f, "export type", &models, "./models.js");
    let inputs: Vec<Ident> = input_models(node).into_iter().map(input_ident).collect();
    let inputs = exported(&inputs, &mut taken);
    export(&mut f, "export type", &inputs, "./inputs.js");
    f
}

/// Returns the names to export `idents` under, as `Name` or `Name as
/// Name$`, each with `$` added until it is not in `taken`, and adds them to
/// it.
fn exported(idents: &[Ident], taken: &mut HashSet<String>) -> Vec<String> {
    let mut names = Vec::new();
    for ident in idents {
        let name = ident.name.clone().into_owned();
        let mut alias = name.clone();
        while taken.contains(&alias) {
            alias.push('$');
        }
        taken.insert(alias.clone());
        names.push(if alias == name {
            name
        } else {
            format!("{name} as {alias}")
        });
    }
    names
}

/// Prints an export of `names` from the module at `spec`, with each name on
/// a line of its own when there is more than one. It prints nothing when
/// there are no names.
fn export(f: &mut File, keyword: &str, names: &[String], spec: &str) {
    match names {
        [] => {}
        [name] => p!(f, keyword, " { ", name, r#" } from ""#, spec, r#"";"#),
        names => {
            p!(f, keyword, " {");
            f.indent(|f| {
                for name in names {
                    p!(f, name, ",");
                }
            });
            p!(f, r#"} from ""#, spec, r#"";"#);
        }
    }
}
