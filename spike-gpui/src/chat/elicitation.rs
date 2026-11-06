//! An agent asking for structured input (ChatPane.tsx's ElicitationCard): a form
//! built from the normalized schema fields acp emits, or a link to open.

use std::collections::HashMap;

use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::checkbox::Checkbox;
use gpui_kit::component::input::{Input, InputState};
use gpui_kit::component::radio::{Radio, RadioGroup};
use gpui_kit::component::*;
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;
use serde_json::{Map, Value, json};

use super::ChatView;
use crate::theme;

pub(super) struct Elicit {
    pub id: String,
    pub url: Option<String>,
    pub message: String,
    /// ElicitationField JSON: key, label, required, description?, default?, input, options?
    pub fields: Vec<Value>,
    pub done: bool,
}

impl Elicit {
    pub fn from_event(e: &Value) -> Self {
        Self {
            id: e["id"].as_str().unwrap_or_default().to_string(),
            url: (e["mode"] == "url").then(|| e["url"].as_str().unwrap_or_default().to_string()),
            message: e["message"].as_str().unwrap_or_default().to_string(),
            fields: e["fields"].as_array().cloned().unwrap_or_default(),
            done: false,
        }
    }
}

/// A pending form's live values: text-like fields in inputs, the rest as JSON.
pub(super) struct Form {
    inputs: HashMap<String, Entity<InputState>>,
    values: HashMap<String, Value>,
    missing: bool,
}

fn input_kind(f: &Value) -> &str {
    f["input"].as_str().unwrap_or("text")
}

fn is_text(f: &Value) -> bool {
    matches!(input_kind(f), "text" | "number" | "integer")
}

impl Form {
    pub fn new(fields: &[Value], window: &mut Window, cx: &mut App) -> Self {
        let mut inputs = HashMap::new();
        let mut values = HashMap::new();
        for f in fields {
            let key = f["key"].as_str().unwrap_or_default().to_string();
            let default = &f["default"];
            if is_text(f) {
                let initial = match default {
                    Value::String(s) => s.clone(),
                    Value::Number(n) => n.to_string(),
                    _ => String::new(),
                };
                let placeholder = if input_kind(f) == "text" { "" } else { "number" };
                inputs.insert(key, cx.new(|cx| InputState::new(window, cx).default_value(initial).placeholder(placeholder)));
            } else {
                let v = match (input_kind(f), default) {
                    (_, d) if !d.is_null() => d.clone(),
                    ("boolean", _) => false.into(),
                    ("multiselect", _) => json!([]),
                    _ => Value::Null,
                };
                values.insert(key, v);
            }
        }
        Self { inputs, values, missing: false }
    }
}

/// The accepted content: numbers parsed, blanks left out. Err when a required
/// field is empty (or a number doesn't parse).
pub(super) fn collect(fields: &[Value], text: impl Fn(&str) -> String, values: &HashMap<String, Value>) -> Result<Map<String, Value>, ()> {
    let mut out = Map::new();
    for f in fields {
        let key = f["key"].as_str().unwrap_or_default();
        let v = if is_text(f) {
            let t = text(key);
            let t = t.trim();
            match input_kind(f) {
                _ if t.is_empty() => Value::Null,
                "integer" => t.parse::<i64>().map(Value::from).map_err(|_| ())?,
                "number" => t.parse::<f64>().ok().and_then(|n| serde_json::Number::from_f64(n)).map(Value::Number).ok_or(())?,
                _ => t.into(),
            }
        } else {
            values.get(key).cloned().unwrap_or(Value::Null)
        };
        let empty = v.is_null() || v.as_array().is_some_and(|a| a.is_empty());
        if empty {
            if f["required"] == true {
                return Err(());
            }
            continue;
        }
        out.insert(key.to_string(), v);
    }
    Ok(out)
}

impl ChatView {
    /// Make inputs for forms that just arrived (render has the window).
    pub(super) fn ensure_forms(&mut self, window: &mut Window, cx: &mut App) {
        for &ix in self.rows.elicits.values() {
            if let Some(super::Row::Elicitation(e)) = self.rows.rows.get(ix) {
                if !e.done && e.url.is_none() && !self.forms.contains_key(&e.id) {
                    self.forms.insert(e.id.clone(), Form::new(&e.fields, window, cx));
                }
            }
        }
    }

    fn set_elicit_value(&mut self, id: &str, key: &str, v: Value, cx: &mut Context<Self>) {
        if let Some(f) = self.forms.get_mut(id) {
            f.values.insert(key.to_string(), v);
            cx.notify();
        }
    }

    /// accept (validated, with the form's content) / decline / cancel.
    fn answer_elicitation(&mut self, id: String, action: &str, cx: &mut Context<Self>) {
        let mut content = None;
        if action == "accept" {
            let fields = self.rows.elicits.get(&id).and_then(|&ix| match self.rows.rows.get(ix) {
                Some(super::Row::Elicitation(e)) => Some(e.fields.clone()),
                _ => None,
            });
            if let (Some(fields), Some(form)) = (fields, self.forms.get_mut(&id)) {
                let inputs = &form.inputs;
                match collect(&fields, |k| inputs.get(k).map(|i| i.read(cx).value().to_string()).unwrap_or_default(), &form.values) {
                    Ok(c) => content = Some(Value::Object(c)),
                    Err(()) => {
                        form.missing = true;
                        return cx.notify();
                    }
                }
            }
        }
        if let Some(a) = &self.agent {
            a.answer_elicitation(&id, action, content);
        }
    }

    pub(super) fn render_elicitation(&self, ix: usize, e: &Elicit, view: &Entity<ChatView>, cx: &App) -> AnyElement {
        let theme = cx.theme().colors;
        let x = theme::extra(cx);
        let card = div()
            .flex()
            .flex_col()
            .gap_2()
            .p_3()
            .rounded_md()
            .border_1()
            .border_color(if e.done { theme.border } else { x.amber })
            .child(div().text_sm().whitespace_normal().child(e.message.clone()));
        let answer = |action: &'static str| {
            let (v, id) = (view.clone(), e.id.clone());
            move |_: &ClickEvent, _: &mut Window, cx: &mut App| v.update(cx, |c, cx| c.answer_elicitation(id.clone(), action, cx))
        };
        if e.done {
            let label = if e.url.is_some() { "Done" } else { "Submitted" };
            return card.child(div().text_sm().text_color(theme.muted_foreground).child(format!("→ {label}"))).into_any_element();
        }
        if let Some(url) = e.url.clone() {
            let open = answer("accept");
            return card
                .child(
                    div()
                        .flex()
                        .gap_2()
                        .child(Button::new(("elicit-open", ix)).primary().label("Open link").on_click(move |ev, w, cx| {
                            cx.open_url(&url);
                            open(ev, w, cx)
                        }))
                        .child(Button::new(("elicit-dismiss", ix)).ghost().label("Dismiss").on_click(answer("cancel"))),
                )
                .into_any_element();
        }
        let Some(form) = self.forms.get(&e.id) else { return card.into_any_element() };
        card.children(e.fields.iter().enumerate().map(|(j, f)| {
            let key = f["key"].as_str().unwrap_or_default().to_string();
            let required = f["required"] == true;
            let value = form.values.get(&key).cloned().unwrap_or(Value::Null);
            let options: Vec<(Value, String)> = f["options"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|o| (o["value"].clone(), o["label"].as_str().map(str::to_string).unwrap_or_else(|| o["value"].to_string())))
                .collect();
            let set = {
                let (v, id, key) = (view.clone(), e.id.clone(), key.clone());
                move |val: Value, cx: &mut App| v.update(cx, |c, cx| c.set_elicit_value(&id, &key, val, cx))
            };
            let id = ix * 64 + j;
            let control: AnyElement = match input_kind(f) {
                "boolean" => Checkbox::new(("elicit-bool", id)).checked(value == true).on_click(move |b: &bool, _, cx| set((*b).into(), cx)).into_any_element(),
                "select" => {
                    let selected = options.iter().position(|(v, _)| *v == value);
                    let values: Vec<Value> = options.iter().map(|o| o.0.clone()).collect();
                    RadioGroup::horizontal(("elicit-radio", id))
                        .selected_index(selected)
                        .on_click(move |i: &usize, _, cx| {
                            if let Some(v) = values.get(*i) {
                                set(v.clone(), cx)
                            }
                        })
                        .children(options.iter().enumerate().map(|(k, (_, label))| Radio::new(("elicit-opt", id * 64 + k)).label(label.clone())))
                        .into_any_element()
                }
                "multiselect" => {
                    let picked: Vec<Value> = value.as_array().cloned().unwrap_or_default();
                    div()
                        .flex()
                        .flex_wrap()
                        .gap_3()
                        .children(options.into_iter().enumerate().map(|(k, (opt, label))| {
                            let (set, picked) = (set.clone(), picked.clone());
                            Checkbox::new(("elicit-multi", id * 64 + k)).label(label).checked(picked.contains(&opt)).on_click(move |on: &bool, _, cx| {
                                let mut next: Vec<Value> = picked.iter().filter(|p| **p != opt).cloned().collect();
                                if *on {
                                    next.push(opt.clone());
                                }
                                set(Value::Array(next), cx)
                            })
                        }))
                        .into_any_element()
                }
                _ => match form.inputs.get(&key) {
                    Some(input) => Input::new(input).into_any_element(),
                    None => div().into_any_element(),
                },
            };
            div()
                .flex()
                .flex_col()
                .gap_1()
                .child(
                    div()
                        .flex()
                        .text_size(px(12.5))
                        .font_weight(FontWeight::MEDIUM)
                        .child(f["label"].as_str().unwrap_or(&key).to_string())
                        .when(required, |d| d.child(div().text_color(x.amber).child(" *"))),
                )
                .when_some(f["description"].as_str(), |d, desc| d.child(div().text_size(px(12.)).text_color(theme.muted_foreground).child(desc.to_string())))
                .child(control)
        }))
        .when(form.missing, |d| d.child(div().text_size(px(12.)).text_color(theme.danger).child("Fill in the required fields (*).")))
        .child(
            div()
                .flex()
                .gap_2()
                .child(Button::new(("elicit-submit", ix)).primary().label("Submit").on_click(answer("accept")))
                .child(Button::new(("elicit-decline", ix)).ghost().label("Decline").on_click(answer("decline"))),
        )
        .into_any_element()
    }
}

#[cfg(test)]
mod tests {
    use super::collect;
    use serde_json::{Value, json};
    use std::collections::HashMap;

    #[test]
    fn collects_and_validates() {
        let fields = vec![
            json!({ "key": "name", "input": "text", "required": true }),
            json!({ "key": "n", "input": "integer" }),
            json!({ "key": "x", "input": "number" }),
            json!({ "key": "ok", "input": "boolean" }),
            json!({ "key": "tags", "input": "multiselect", "required": false }),
        ];
        let values: HashMap<String, Value> = [("ok".to_string(), json!(true)), ("tags".to_string(), json!([]))].into();
        let text = |k: &str| match k {
            "name" => " Ada ".to_string(),
            "n" => "3".to_string(),
            _ => String::new(),
        };
        let c = collect(&fields, text, &values).unwrap();
        assert_eq!(Value::Object(c), json!({ "name": "Ada", "n": 3, "ok": true }));
        assert!(collect(&fields, |_| String::new(), &values).is_err());
        assert!(collect(&fields[1..2], |_| "x".into(), &values).is_err());
    }
}
