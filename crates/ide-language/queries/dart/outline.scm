(class_declaration name: (identifier) @name) @def.class
(mixin_declaration name: (identifier) @name) @def.class
(extension_declaration name: (identifier) @name) @outline.extension
(extension_type_declaration name: (identifier) @name) @def.class
(enum_declaration name: (identifier) @name) @def.enum
(enum_entry name: (identifier) @name) @def.enum_member
(type_alias (type_identifier) @name) @def.type
(member_declaration (declaration (constructor_signature name: (identifier) @name "." name: (identifier) @name parameters: (formal_parameter_list) @detail))) @def.constructor
(member_declaration (declaration (constructor_signature name: (identifier) @name parameters: (formal_parameter_list) @detail))) @def.constructor
(member_declaration (declaration (factory_constructor_signature (identifier) @name))) @def.constructor
(member_declaration (declaration (constant_constructor_signature (identifier) @name))) @def.constructor
(member_declaration (method_declaration signature: (method_signature (function_signature name: (identifier) @name parameters: (formal_parameter_list) @detail)))) @def.method
(member_declaration (method_declaration signature: (method_signature (getter_signature name: (identifier) @name)))) @def.property
(member_declaration (method_declaration signature: (method_signature (setter_signature name: (identifier) @name)))) @def.property
(member_declaration (declaration (function_signature name: (identifier) @name parameters: (formal_parameter_list) @detail))) @def.method
(member_declaration (declaration (initialized_identifier_list (initialized_identifier name: (identifier) @name)))) @def.field
(member_declaration (declaration (static_final_declaration_list (static_final_declaration name: (identifier) @name)))) @def.constant
(function_declaration signature: (function_signature name: (identifier) @name parameters: (formal_parameter_list) @detail)) @def.function
(top_level_variable_declaration (static_final_declaration_list (static_final_declaration name: (identifier) @name))) @def.constant
(top_level_variable_declaration (initialized_identifier_list (initialized_identifier name: (identifier) @name))) @def.variable
